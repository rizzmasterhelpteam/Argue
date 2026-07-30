import { handleStatus } from '../server/api.js';
import { handleVercelRoute } from '../server/vercel-handler.js';

export default function handler(req, res) {
  return handleVercelRoute(req, res, 'GET', handleStatus);
}
