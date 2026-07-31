import { useEffect, useState } from 'react';
import { Check, Crown, Lightning, X } from '@phosphor-icons/react';

const PLANS = [
  { id: 'free', name: 'Free', detail: 'For testing the waters', features: ['3 text replies each month', '2 voice minutes each month', '2-minute voice sessions'] },
  { id: 'starter', name: 'Starter', detail: 'For regular practice', features: ['5,000 text replies each month', '3 voice hours each month', '15-minute voice sessions'] },
  { id: 'pro', name: 'Pro', detail: 'For serious debaters', features: ['20,000 text replies each month', '10 voice hours each month', '30-minute voice sessions'], featured: true },
];

export function PricingModal({ usage, onClose, onCheckout }) {
  const [checkoutPlan, setCheckoutPlan] = useState('');
  const currentPlan = usage?.plan || 'free';

  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === 'Escape' && !checkoutPlan) onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [checkoutPlan, onClose]);

  const choosePlan = async (plan) => {
    if (plan === 'free' || plan === currentPlan) return;
    setCheckoutPlan(plan);
    try { await onCheckout(plan); } catch { setCheckoutPlan(''); }
  };

  return <div className="pricing-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !checkoutPlan) onClose(); }}>
    <section className="pricing-modal" role="dialog" aria-modal="true" aria-labelledby="pricing-title">
      <button className="pricing-close" type="button" aria-label="Close plans" disabled={Boolean(checkoutPlan)} onClick={onClose}><X size={20} /></button>
      <header><span className="usage-kicker">ARGUE AI MEMBERSHIP</span><h2 id="pricing-title">Pick your edge.</h2><p>Scale the practice, not the noise.</p></header>
      <div className="pricing-grid">{PLANS.map((plan) => {
        const isCurrent = plan.id === currentPlan;
        const isLoading = plan.id === checkoutPlan;
        return <article key={plan.id} className={`pricing-plan ${plan.featured ? 'featured' : ''} ${isCurrent ? 'current' : ''}`}>
          <div className="pricing-plan-top"><span>{plan.featured ? <Crown size={18} weight="fill" /> : <Lightning size={18} weight="fill" />}</span>{plan.featured && <small>Most capable</small>}</div>
          <h3>{plan.name}</h3><p>{plan.detail}</p>
          <ul>{plan.features.map((feature) => <li key={feature}><Check size={15} weight="bold" />{feature}</li>)}</ul>
          <button type="button" disabled={Boolean(checkoutPlan) || isCurrent} onClick={() => choosePlan(plan.id)}>{isCurrent ? 'Current plan' : isLoading ? 'Opening checkout...' : `Choose ${plan.name}`}</button>
        </article>;
      })}</div>
      <footer>Secure checkout powered by Dodo Payments.</footer>
    </section>
  </div>;
}
