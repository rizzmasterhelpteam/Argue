import { handleDodoSubscriptionSync } from '../../server/dodo-payments.js';
import { handleVercelRoute } from '../../server/vercel-handler.js';

export default function handler(req, res) {
  return handleVercelRoute(req, res, 'GET', handleDodoSubscriptionSync);
}
