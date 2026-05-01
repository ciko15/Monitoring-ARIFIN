document.addEventListener('DOMContentLoaded', () => {
    // Initialization of defaults
    const endInput = document.getElementById('analyticEndDate');
    const startInput = document.getElementById('analyticStartDate');
    if (endInput && startInput) {
        const today = new Date();
        endInput.value = today.toISOString().split('T')[0];
        
        const lastWeek = new Date();
        lastWeek.setDate(lastWeek.getDate() - 7);
        startInput.value = lastWeek.toISOString().split('T')[0];
    }

    // Search Filtering
    const searchInput = document.getElementById('analyticSearch');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            window.renderFilteredEquipments(e.target.value);
        });
    }

    // Handle Form Submit
    const form = document.getElementById('analyticsFilterForm');
    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            await window.fetchAndRenderChart();
        });
    }
});

// Global State
let allEquipments = [];
let analyticChartInstance = null;

/**
 * Global function to fetch equipment list and populate the select box.
 * Called by switchSection in app.js when analytics-dashboard is selected.
 */
window.populateEquipmentSelect = async function() {
    try {
        const select = document.getElementById('analyticEquipments');
        // Only fetch if data is empty to keep it efficient
        if (allEquipments.length === 0) {
            const res = await fetch('/api/equipment?isActive=all');
            const data = await res.json();
            allEquipments = data.data || data;
        }
        window.renderFilteredEquipments(document.getElementById('analyticSearch')?.value || '');
    } catch (e) {
        console.error('Failed to load equipments for analytics:', e);
    }
};

/**
 * Filter the equipment dropdown based on search term
 */
window.renderFilteredEquipments = function(searchTerm) {
    const select = document.getElementById('analyticEquipments');
    if (!select) return;
    
    const term = searchTerm.toLowerCase();
    
    // Save current selection to avoid losing it while filtering
    const selectedIds = Array.from(select.selectedOptions).map(opt => opt.value);
    
    select.innerHTML = '';
    allEquipments.forEach(eq => {
        const name = eq.name || 'Unknown';
        const cat = eq.category || 'General';
        
        if (name.toLowerCase().includes(term) || cat.toLowerCase().includes(term)) {
            const opt = document.createElement('option');
            opt.value = eq.id;
            opt.dataset.name = name;
            opt.textContent = `${name} (${cat})`;
            if (selectedIds.includes(String(eq.id))) opt.selected = true;
            select.appendChild(opt);
        }
    });
};

/**
 * Main function to fetch aggregated data for all selected equipments and render the chart
 */
window.fetchAndRenderChart = async function() {
    const select = document.getElementById('analyticEquipments');
    const selectedOptions = Array.from(select.selectedOptions);
    
    if (selectedOptions.length === 0) {
        alert('Please select at least one equipment.');
        return;
    }
    
    // Mapping interval to timeframe (tf) for fileLogger
    const intervalMapper = {
        'hour': '24h',
        'day': '7d', // Default to 7d for daily view
        'week': '30d',
        'month': '1y'
    };
    const interval = document.getElementById('analyticInterval').value;
    const tf = intervalMapper[interval] || '24h';
    
    try {
        const fetchPromises = selectedOptions.map(async opt => {
            const id = opt.value;
            const name = opt.dataset.name;
            const res = await fetch(`/api/equipment/${id}/chart/aggregated?tf=${tf}`);
            const data = await res.json();
            return { id, name, logs: data };
        });

        const results = await Promise.all(fetchPromises);
        window.renderChartResult(results);
    } catch (e) {
        console.error('Failed to fetch chart data:', e);
        alert('Failed to fetch chart data: ' + e.message);
    }
};

/**
 * Render multi-line chart using Chart.js
 */
window.renderChartResult = function(results) {
    const canvas = document.getElementById('analyticChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    if (analyticChartInstance) {
        analyticChartInstance.destroy();
    }
    
    // Collect all unique timestamps across all results to build the X-axis
    const allTimestamps = new Set();
    results.forEach(res => {
        if (Array.isArray(res.logs)) {
            res.logs.forEach(entry => allTimestamps.add(entry.timestamp));
        }
    });
    
    const sortedLabels = Array.from(allTimestamps).sort();
    
    const datasets = [];
    const colors = [
        '#3b82f6', '#ef4444', '#10b981', '#f59e0b', 
        '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'
    ];
    let colorIndex = 0;

    results.forEach(res => {
        const eqName = res.name;
        if (!Array.isArray(res.logs)) return;

        // Find all unique source IPs for this equipment in this timeframe
        const sourceIps = new Set();
        res.logs.forEach(bucket => {
            if (bucket.sources) {
                Object.keys(bucket.sources).forEach(ip => sourceIps.add(ip));
            }
        });
        
        sourceIps.forEach(ip => {
            // Find all parameters (keys) for this specific source
            const parameterKeys = new Set();
            res.logs.forEach(bucket => {
                if (bucket.sources && bucket.sources[ip]) {
                    Object.keys(bucket.sources[ip]).forEach(k => parameterKeys.add(k));
                }
            });
            
            parameterKeys.forEach(param => {
                const dataPoints = sortedLabels.map(ts => {
                    const bucket = res.logs.find(l => l.timestamp === ts);
                    if (bucket && bucket.sources && bucket.sources[ip] && bucket.sources[ip][param] !== undefined) {
                        return bucket.sources[ip][param];
                    }
                    return null;
                });
                
                const color = colors[colorIndex % colors.length];
                datasets.push({
                    label: `${eqName} [${ip}] - ${param}`,
                    data: dataPoints,
                    borderColor: color,
                    backgroundColor: color + '22',
                    borderWidth: 2,
                    pointRadius: 3,
                    fill: false,
                    tension: 0.2,
                    spanGaps: true
                });
                
                colorIndex++;
            });
        });
    });

    analyticChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: sortedLabels.map(ts => {
                const date = new Date(ts);
                return date.toLocaleString();
            }),
            datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false,
            },
            plugins: {
                title: {
                    display: true,
                    text: 'Equipment & Data Source Performance',
                    color: 'rgba(255, 255, 255, 0.9)',
                    font: { size: 16 }
                },
                legend: {
                    position: 'bottom',
                    labels: { color: 'rgba(255, 255, 255, 0.7)', boxWidth: 10 }
                },
                tooltip: {
                    backgroundColor: 'rgba(15, 23, 42, 0.9)',
                    padding: 12,
                    cornerRadius: 8
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: 'rgba(255, 255, 255, 0.5)' }
                },
                y: {
                    beginAtZero: false,
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: 'rgba(255, 255, 255, 0.5)' }
                }
            }
        }
    });
};
