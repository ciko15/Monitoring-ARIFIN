const fs = require('fs');
let content = fs.readFileSync('public/enhancements.js', 'utf8');

const searchStr = `            } else {
                // Fallback to existing logic: show keys present in data
                if (sections.length === 0) {
                    const params = Object.entries(data)
                        .filter(([k, v]) => !k.startsWith('_') && !isMetricPlaceholder(v))
                        .map(([k, v]) => {
                            const label = k.replace(/_/g, ' ').toUpperCase();
                            const displayValue = parserId && parserId.startsWith('snmp_')
                                ? formatSnmpMetricValue(k, v)
                                : v;
                            return [label, displayValue, getLimitColor(supCategory, label, v)];
                        });
                    sections.push({ title: 'DATA', params: params.length > 0 ? params : [['No data available', '—', '#4a7a9a']] });
                }
            }`;

const replaceStr = `            } else {
                // Fallback to existing logic: show keys present in data, with support for nested groups
                if (sections.length === 0) {
                    const flatParams = [];
                    Object.entries(data).forEach(([k, v]) => {
                        if (k.startsWith('_') || isMetricPlaceholder(v)) return;
                        
                        if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
                            // This is a nested group!
                            const groupParams = Object.entries(v)
                                .filter(([gk, gv]) => !gk.startsWith('_') && !isMetricPlaceholder(gv))
                                .map(([gk, gv]) => {
                                    const label = gk.replace(/_/g, ' ').toUpperCase();
                                    return [label, gv, getLimitColor(supCategory, label, gv)];
                                });
                            if (groupParams.length > 0) {
                                sections.push({ title: k.toUpperCase(), params: groupParams });
                            }
                        } else {
                            // Flat metric
                            const label = k.replace(/_/g, ' ').toUpperCase();
                            const displayValue = parserId && parserId.startsWith('snmp_')
                                ? formatSnmpMetricValue(k, v)
                                : v;
                            flatParams.push([label, displayValue, getLimitColor(supCategory, label, v)]);
                        }
                    });
                    
                    if (flatParams.length > 0) {
                        sections.unshift({ title: sections.length > 0 ? 'GENERAL' : 'DATA', params: flatParams });
                    }
                    
                    if (sections.length === 0) {
                        sections.push({ title: 'DATA', params: [['No data available', '—', '#4a7a9a']] });
                    }
                }
            }`;

content = content.replace(searchStr, replaceStr);
fs.writeFileSync('public/enhancements.js', content);
