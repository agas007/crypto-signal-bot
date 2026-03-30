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

module.exports = { formatJakartaTime };
