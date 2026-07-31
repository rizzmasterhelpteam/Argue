import { handleDodoCheckout } from '../../server/dodo-payments.js';
import { handleVercelRoute } from '../../server/vercel-handler.js';

export const config = { api: { bodyParser: false } };

export default function handler(req, res) {
  return handleVercelRoute(req, res, 'POST', handleDodoCheckout);
}
