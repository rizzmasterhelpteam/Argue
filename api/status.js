import { handleStatus, handleUsage } from '../server/api.js';
import { handleVercelRoute } from '../server/vercel-handler.js';

export default function handler(req, res) {
  const route = Array.isArray(req.query?.route) ? req.query.route[0] : req.query?.route;
  if (route === 'usage') return handleVercelRoute(req, res, 'GET', handleUsage);
  return handleVercelRoute(req, res, 'GET', handleStatus);
}
