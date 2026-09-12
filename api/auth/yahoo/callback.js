// Dedicated Yahoo redirect URL. Reuse the server-only OAuth implementation so
// state validation, encrypted token storage and session cookies stay identical.
const yahooAuth = require('../yahoo.js');

module.exports = async function callback(req, res) {
  // The path always means callback, even with missing parameters or an
  // unrelated action supplied in the query string.
  req.query = { ...req.query, action: 'callback' };
  return yahooAuth(req, res);
};
