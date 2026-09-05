/**
 * Central Financial & Currency Conversion Utility
 * Handles conversion between Legacy Float SAR and Integer Halalas with exact rounding
 */

const CurrencyUtil = {
    /**
     * Converts SAR float to Integer Halalas
     * @param {number|string} sarAmount
     * @returns {number} Integer Halalas
     */
    sarToHalalas: (sarAmount) => {
        const num = parseFloat(sarAmount);
        if (isNaN(num)) return 0;
        return Math.round(num * 100);
    },

    /**
     * Converts Integer Halalas to SAR float (rounded to 2 decimal places)
     * @param {number|string} halalasAmount
     * @returns {number} SAR float
     */
    halalasToSar: (halalasAmount) => {
        const num = parseInt(halalasAmount, 10);
        if (isNaN(num)) return 0;
        return Math.round(num) / 100;
    },

    /**
     * Formats Halalas to a clean SAR currency string (e.g. 1500.50 ر.س)
     * @param {number|string} halalasAmount
     * @returns {string} Formatted string
     */
    formatHalalasToSar: (halalasAmount) => {
        const sar = CurrencyUtil.halalasToSar(halalasAmount);
        return `${sar.toFixed(2)} ر.س`;
    }
};

module.exports = CurrencyUtil;
