const { analyzeTrend, classifyStrength } = require('./trend');
const { calculateStochastic } = require('./stochastic');
const { findSupportResistance } = require('./supportResistance');
const { analyzeStructure } = require('./structure');

module.exports = {
  analyzeTrend,
  classifyStrength,
  calculateStochastic,
  findSupportResistance,
  analyzeStructure,
};
