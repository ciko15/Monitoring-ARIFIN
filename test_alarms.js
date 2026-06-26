const limits = {
    CRS_RF:   [85.0, 115.0],
    WIDTH_RF:  [85.0, 115.0],
    CLR_RF:    [85.0, 115.0],
    NF_RF:     [70.0, 125.0],
    CRS_SDM:   [35.0,  45.0],
    WIDTH_SDM: [35.0,  45.0],
    CLR_SDM:   [35.0,  45.0],
    NF_SDM:    [35.0,  45.0],
    IDENT_AM:  [5.0,   20.0],
};
const params = {
    CRS_RF: 99.1,
    CRS_DDM: 0,
    CRS_SDM: 40.5,
    IDENT_AM: 8,
    WIDTH_RF: 98.9,
    WIDTH_DDM: -0.0034,
    WIDTH_SDM: 40.6,
    CLR_RF: 102.2,
    CLR_DDM: 0.2568,
    CLR_SDM: 40.1,
    NF_RF: 99.5,
    NF_DDM: 0.0051,
    NF_SDM: 40.1,
    FREQ_DEV: 0
};
for (const [key, lim] of Object.entries(limits)) {
    const v = params[key];
    if (v == null) continue;
    if (v < lim[0] || v > lim[1]) {
        console.log("ALARM:", key, v);
    }
}
