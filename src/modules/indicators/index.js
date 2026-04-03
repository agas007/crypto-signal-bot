const { analyzeTrend, classifyStrength } = require('./trend');
const { calculateStochastic } = require('./stochastic');
const { findSupportResistance } = require('./supportResistance');
const { analyzeStructure } = require('./structure');
const { calculateATR, detectAtSpike } = require('./volatility');
const { detectRetest } = require('./retest');

module.exports = {
  analyzeTrend,
  classifyStrength,
  calculateStochastic,
  findSupportResistance,
  analyzeStructure,
  calculateATR,
  detectAtSpike,
  detectRetest,
};
