const { analyzeTrend, classifyStrength, detectEma1321 } = require('./trend');
const { calculateStochastic, detectStochCross, detectDivergence } = require('./stochastic');
const { findSupportResistance } = require('./supportResistance');
const { analyzeStructure, findSwingPoints } = require('./structure');
const { calculateATR, detectAtSpike } = require('./volatility');
const { detectRetest } = require('./retest');
const { detectOrderBlocks } = require('./orderBlock');

module.exports = {
  // Trend
  analyzeTrend,
  classifyStrength,
  detectEma1321,
  // Stochastic
  calculateStochastic,
  detectStochCross,
  detectDivergence,
  // Structure
  findSupportResistance,
  analyzeStructure,
  findSwingPoints,
  // Other
  calculateATR,
  detectAtSpike,
  detectRetest,
  // Order Block
  detectOrderBlocks,
};
