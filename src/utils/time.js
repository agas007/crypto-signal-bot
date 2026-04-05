/**
 * Utility functions for time management in the bot.
 */

/**
 * Format a date object or current time to Jakarta timezone (UTC+7)
 * 
 * @param {Date} [date=new Date()]
 * @param {'ISO' | 'readable' | 'short' | 'terminal'} format
 * @returns {string}
 */
function formatJakartaTime(date = new Date(), format = 'readable') {
  const options = {
    timeZone: 'Asia/Jakarta',
  };

  switch (format) {
    case 'ISO':
      // Simplified ISO-like for Jakarta
      return date.toLocaleString('sv-SE', { ...options, hour12: false }).replace(' ', 'T') + '+07:00';
    case 'short':
      return date.toLocaleString('id-ID', {
        ...options,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
    case 'terminal':
      const p = new Intl.DateTimeFormat('en-GB', {
        ...options,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).formatToParts(date);
      const find = (type) => p.find(pt => pt.type === type).value;
      return `${find('day')}-${find('month')}-${find('year')} ${find('hour')}:${find('minute')}:${find('second')}`;
    case 'readable':
    default:
      return date.toLocaleString('id-ID', {
        ...options,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
  }
}

/**
 * Returns the Unix timestamp (ms) for the most recent 09:00 WIB reset.
 * If it's 10:00 WIB, returns today 09:00 WIB.
 * If it's 08:00 WIB, returns yesterday 09:00 WIB.
 */
function getJakartaResetTime() {
  const now = new Date();
  const offset = 7 * 60 * 60 * 1000;
  // Shift to Jakarta time
  const jakartaNow = new Date(now.getTime() + offset);
  
  // Today's 09:00 in Jakarta relative terms
  const todayReset = new Date(Date.UTC(
    jakartaNow.getUTCFullYear(),
    jakartaNow.getUTCMonth(),
    jakartaNow.getUTCDate(),
    9, 0, 0, 0
  ));
  
  let resetTime = todayReset.getTime() - offset;
  
  // If we haven't reached 09:00 yet today, the reset happened yesterday at 09:00
  if (now.getTime() < resetTime) {
    resetTime -= (24 * 60 * 60 * 1000);
  }
  
  return resetTime;
}

/**
 * Returns the Unix timestamp (ms) for the START of the NEXT day's 09:00 WIB reset.
 */
function getNextJakartaReset() {
  return getJakartaResetTime() + (24 * 60 * 60 * 1000);
}

module.exports = { formatJakartaTime, getJakartaResetTime, getNextJakartaReset };
