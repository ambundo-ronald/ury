import { useEffect, useRef, useState } from 'react';
import { Check, Loader, Search, Smartphone, X } from 'lucide-react';
import { Button, Input, cn } from '@ury/ui';
import { formatCurrency, parseFrappeError } from '@ury/core';
import { getStkStatus, requestStk, searchReceived, type ReceivedPayment } from '../lib/mpesa-api';
import { t } from '../i18n';

/** M-Pesa payments chosen for one mode of payment: received ones picked, or prompts paid. */
export interface MpesaSelection {
  received: { name: string; code: string; amount: number }[];
  prompts: { name: string; code: string; amount: number }[];
}

export const EMPTY_SELECTION: MpesaSelection = { received: [], prompts: [] };

export const selectionTotal = (s: MpesaSelection) =>
  [...s.received, ...s.prompts].reduce((sum, p) => sum + p.amount, 0);

interface MpesaPanelProps {
  posProfile: string;
  invoice: string;
  /** Still to pay, for the prompt's amount. */
  remaining: number;
  defaultPhone?: string;
  canPrompt: boolean;
  selection: MpesaSelection;
  onChange: (selection: MpesaSelection) => void;
  disabled?: boolean;
}

const POLL_MS = 3000;
// Safaricom gives the customer about a minute to enter the PIN.
const GIVE_UP_MS = 120000;

function minutesAgo(received: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(received.replace(' ', 'T')).getTime()) / 60000));
  if (minutes < 1) return t('mpesa.just_now');
  if (minutes < 60) return t('mpesa.minutes_ago', { count: minutes });
  return t('mpesa.hours_ago', { count: Math.round(minutes / 60) });
}

const MpesaPanel = ({ posProfile, invoice, remaining, defaultPhone, canPrompt, selection, onChange, disabled }: MpesaPanelProps) => {
  const [tab, setTab] = useState<'received' | 'prompt'>('received');

  // Received payments
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<ReceivedPayment[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState('');

  // Prompt
  const [phone, setPhone] = useState(defaultPhone || '');
  const [amount, setAmount] = useState(remaining > 0 ? String(Math.round(remaining)) : '');
  const [prompt, setPrompt] = useState<{ state: 'idle' | 'sending' | 'waiting' | 'failed'; message?: string; request?: string }>({ state: 'idle' });
  const pollTimer = useRef<number | null>(null);
  // The latest selection, for a prompt that gets paid while the cashier picks other payments.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  useEffect(() => {
    if (tab !== 'received') return;
    const term = search.trim();
    if (term && term.length < 3) {
      setResults([]);
      return;
    }
    setLoading(true);
    setListError('');
    const handle = window.setTimeout(() => {
      searchReceived(posProfile, term)
        .then(setResults)
        .catch((err) => setListError(parseFrappeError(err, t('mpesa.load_failed'))))
        .finally(() => setLoading(false));
    }, 300);
    return () => window.clearTimeout(handle);
  }, [search, tab, posProfile]);

  useEffect(() => () => {
    if (pollTimer.current) window.clearTimeout(pollTimer.current);
  }, []);

  useEffect(() => {
    if (prompt.state === 'idle') setAmount(remaining > 0 ? String(Math.round(remaining)) : '');
  }, [remaining, prompt.state]);

  const isPicked = (name: string) => selection.received.some((p) => p.name === name);

  const togglePayment = (payment: ReceivedPayment) => {
    const received = isPicked(payment.name)
      ? selection.received.filter((p) => p.name !== payment.name)
      : [...selection.received, { name: payment.name, code: payment.code, amount: payment.amount }];
    onChange({ ...selection, received });
  };

  const removePrompt = (name: string) => onChange({ ...selection, prompts: selection.prompts.filter((p) => p.name !== name) });

  const poll = (request: string, startedAt: number) => {
    pollTimer.current = window.setTimeout(async () => {
      try {
        const status = await getStkStatus(posProfile, request);
        if (status.status === 'paid') {
          const current = selectionRef.current;
          onChange({ ...current, prompts: [...current.prompts, { name: request, code: status.receipt || request, amount: status.amount }] });
          setPrompt({ state: 'idle' });
          return;
        }
        if (status.status === 'failed') {
          setPrompt({ state: 'failed', message: status.message });
          return;
        }
      } catch {
        // A dropped connection while waiting: keep trying until the time is up.
      }
      if (Date.now() - startedAt > GIVE_UP_MS) {
        setPrompt({ state: 'failed', message: t('mpesa.no_answer'), request });
        return;
      }
      poll(request, startedAt);
    }, POLL_MS);
  };

  const sendPrompt = async () => {
    const value = Number(amount);
    if (!phone.trim() || !(value > 0)) return;
    setPrompt({ state: 'sending' });
    try {
      const sent = await requestStk(posProfile, invoice, phone, value);
      setPrompt({ state: 'waiting', message: t('mpesa.waiting', { phone: sent.phone, amount: formatCurrency(sent.amount) }), request: sent.request });
      poll(sent.request, Date.now());
    } catch (err) {
      setPrompt({ state: 'failed', message: parseFrappeError(err, t('mpesa.send_failed')) });
    }
  };

  const checkAgain = () => {
    if (!prompt.request) return;
    setPrompt({ state: 'waiting', message: t('mpesa.checking'), request: prompt.request });
    poll(prompt.request, Date.now() - GIVE_UP_MS + POLL_MS * 2);
  };

  const chosen = [...selection.received.map((p) => ({ ...p, prompt: false })), ...selection.prompts.map((p) => ({ ...p, prompt: true }))];

  return (
    <div className={cn('rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-3', disabled && 'opacity-60 pointer-events-none')}>
      <div className="flex gap-1 rounded-md bg-white p-1 border border-gray-200">
        <button
          type="button"
          onClick={() => setTab('received')}
          className={cn('flex-1 rounded px-3 py-1.5 text-sm font-medium', tab === 'received' ? 'bg-primary-600 text-white' : 'text-gray-700 hover:bg-gray-100')}
        >
          {t('mpesa.received_tab')}
        </button>
        {canPrompt && (
          <button
            type="button"
            onClick={() => setTab('prompt')}
            className={cn('flex-1 rounded px-3 py-1.5 text-sm font-medium', tab === 'prompt' ? 'bg-primary-600 text-white' : 'text-gray-700 hover:bg-gray-100')}
          >
            {t('mpesa.prompt_tab')}
          </button>
        )}
      </div>

      {tab === 'received' && (
        <div className="space-y-2">
          <div className="relative">
            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('mpesa.search_placeholder')}
              size="sm"
              className="ps-9"
            />
          </div>
          <div className="max-h-56 overflow-y-auto rounded-md border border-gray-200 bg-white divide-y divide-gray-100">
            {loading && (
              <div className="flex items-center justify-center gap-2 p-3 text-sm text-gray-500">
                <Loader className="h-4 w-4 animate-spin" /> {t('common.searching')}
              </div>
            )}
            {!loading && listError && <p className="p-3 text-sm text-red-600">{listError}</p>}
            {!loading && !listError && results.length === 0 && (
              <p className="p-3 text-sm text-gray-500">
                {search.trim().length > 0 && search.trim().length < 3 ? t('mpesa.type_more') : t('mpesa.none_received')}
              </p>
            )}
            {!loading &&
              results.map((payment) => {
                const picked = isPicked(payment.name);
                return (
                  <button
                    key={payment.name}
                    type="button"
                    onClick={() => togglePayment(payment)}
                    className={cn('flex w-full items-center gap-3 px-3 py-2 text-start hover:bg-gray-50', picked && 'bg-primary-50')}
                  >
                    <span
                      className={cn(
                        'flex h-5 w-5 shrink-0 items-center justify-center rounded border',
                        picked ? 'border-primary-600 bg-primary-600 text-white' : 'border-gray-300'
                      )}
                    >
                      {picked && <Check className="h-3.5 w-3.5" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-gray-900 break-words">{payment.payer || payment.code}</span>
                      <span className="block text-xs text-gray-500">
                        {payment.code}
                        {payment.phone && ` · ${payment.phone}`} · {minutesAgo(payment.received)}
                      </span>
                    </span>
                    <span
                      className={cn(
                        'text-sm font-semibold tabular-nums',
                        Math.abs(payment.amount - remaining) < 0.5 ? 'text-green-700' : 'text-gray-900'
                      )}
                    >
                      {formatCurrency(payment.amount)}
                    </span>
                  </button>
                );
              })}
          </div>
        </div>
      )}

      {tab === 'prompt' && canPrompt && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <Input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder={t('mpesa.phone_placeholder')}
              size="sm"
              className="flex-1"
              disabled={prompt.state === 'sending' || prompt.state === 'waiting'}
            />
            <Input
              type="number"
              min="1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              size="sm"
              className="w-28"
              disabled={prompt.state === 'sending' || prompt.state === 'waiting'}
            />
          </div>
          {prompt.state === 'waiting' ? (
            <div className="flex items-center gap-2 rounded-md bg-white border border-gray-200 p-3 text-sm text-gray-700">
              <Loader className="h-4 w-4 shrink-0 animate-spin text-primary-600" />
              <span>{prompt.message}</span>
            </div>
          ) : (
            <Button onClick={sendPrompt} size="sm" className="w-full" disabled={prompt.state === 'sending' || !phone.trim() || !(Number(amount) > 0)}>
              <Smartphone className="h-4 w-4 me-2" />
              {prompt.state === 'sending' ? t('mpesa.sending') : t('mpesa.send_prompt')}
            </Button>
          )}
          {prompt.state === 'failed' && (
            <div className="space-y-2">
              <p className="text-sm text-red-600">{prompt.message}</p>
              {prompt.request && (
                <Button onClick={checkAgain} size="sm" variant="outline" className="w-full">
                  {t('mpesa.check_again')}
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {chosen.length > 0 && (
        <div className="space-y-1">
          {chosen.map((p) => (
            <div key={p.name} className="flex items-center justify-between rounded-md bg-white border border-green-200 px-3 py-1.5 text-sm">
              <span className="flex items-center gap-2 text-green-800">
                <Check className="h-4 w-4" />
                {p.code}
              </span>
              <span className="flex items-center gap-2">
                <span className="font-semibold tabular-nums">{formatCurrency(p.amount)}</span>
                <button
                  type="button"
                  aria-label={t('mpesa.remove')}
                  onClick={() => (p.prompt ? removePrompt(p.name) : togglePayment({ ...p, payer: '', phone: '', reference: '', received: '' }))}
                  className="rounded p-0.5 text-gray-400 hover:text-gray-700"
                >
                  <X className="h-4 w-4" />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default MpesaPanel;
