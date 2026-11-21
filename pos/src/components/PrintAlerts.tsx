import { useCallback, useEffect, useRef, useState } from 'react';
import { parseFrappeError } from '@ury/core';
import { showToast } from '@ury/ui';
import { usePOSStore } from '../store/pos-store';
import { getRealtimeSocket } from '../lib/realtime';
import { dismissPrintJob, getPrintProblems, retryPrintJob, type PrintProblems } from '../lib/print-jobs-api';
import { t } from '../i18n';

const POLL_MS = 20_000;
const EMPTY: PrintProblems = { failed: [], waiting: [], offline_agents: [] };

/**
 * Tells the cashier when a kitchen ticket or bill did not print, so it is
 * never silently lost: failed jobs (with Reprint), jobs waiting too long, and
 * print agents (the URY POS Windows app) that stopped reporting in.
 * The server returns nothing for waiters. See ury/ury/printing.
 */
const PrintAlerts: React.FC = () => {
  const { posProfile } = usePOSStore();
  const branch = posProfile?.branch || '';
  const [problems, setProblems] = useState<PrintProblems>(EMPTY);
  const [busy, setBusy] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const known = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const next = await getPrintProblems();
      // Reopen the panel when something new goes wrong.
      const fresh = next.failed.some((job) => !known.current.has(job.name));
      known.current = new Set(next.failed.map((job) => job.name));
      if (fresh) setCollapsed(false);
      setProblems(next);
    } catch {
      // Offline or signed out: keep showing what we had.
    }
  }, []);

  useEffect(() => {
    if (!branch) return;
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(timer);
  }, [branch, refresh]);

  // Failures are pushed at once, so the cashier need not wait for the poll.
  useEffect(() => {
    if (!branch) return;
    const event = `ury_print_alert_${branch}`;
    const handler = (payload: { label?: string }) => {
      showToast.error(t('print_alerts.toast', { label: payload?.label || '' }));
      refresh();
    };
    let active: Awaited<ReturnType<typeof getRealtimeSocket>> | null = null;
    let cancelled = false;
    getRealtimeSocket()
      .then((socket) => {
        if (cancelled) return;
        active = socket;
        socket.on(event, handler);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      active?.off(event, handler);
    };
  }, [branch, refresh]);

  const act = async (job: string, action: 'retry' | 'dismiss') => {
    setBusy(job);
    try {
      if (action === 'retry') {
        const status = await retryPrintJob(job);
        if (status === 'Failed') showToast.error(t('print_alerts.still_failing'));
        else showToast.success(t('print_alerts.sent_again'));
      } else {
        await dismissPrintJob(job);
      }
    } catch (error) {
      showToast.error(parseFrappeError(error, t('print_alerts.action_failed')));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const total = problems.failed.length + problems.waiting.length + problems.offline_agents.length;
  if (!branch || total === 0) return null;

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        className="fixed bottom-4 right-4 z-[900] rounded-full bg-red-600 px-4 py-2 text-sm font-bold text-white shadow-lg active:bg-red-700"
      >
        {t('print_alerts.badge', { count: total })}
      </button>
    );
  }

  return (
    <div
      role="alert"
      className="fixed bottom-4 right-4 z-[900] w-[min(24rem,calc(100vw-2rem))] max-h-[60vh] overflow-y-auto rounded-xl border border-red-200 bg-white shadow-2xl"
    >
      <div className="flex items-center justify-between gap-2 border-b border-red-100 bg-red-50 px-4 py-2">
        <span className="font-bold text-red-800">{t('print_alerts.title')}</span>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          className="rounded px-2 py-1 text-sm text-red-800 hover:bg-red-100"
        >
          {t('print_alerts.hide')}
        </button>
      </div>

      {problems.offline_agents.map((agent) => (
        <div key={agent.name} className="border-b border-gray-100 px-4 py-2 text-sm text-gray-800">
          {t('print_alerts.agent_offline', { agent: agent.name })}
        </div>
      ))}

      {problems.failed.map((job) => (
        <div key={job.name} className="border-b border-gray-100 px-4 py-2">
          <div className="text-sm font-semibold text-gray-900">{job.label}</div>
          <div className="text-xs text-gray-600">
            {job.printer}
            {job.error ? ` · ${job.error}` : ''}
          </div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={busy === job.name}
              onClick={() => act(job.name, 'retry')}
              className="rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              {t('print_alerts.reprint')}
            </button>
            <button
              type="button"
              disabled={busy === job.name}
              onClick={() => act(job.name, 'dismiss')}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 disabled:opacity-50"
            >
              {t('print_alerts.dismiss')}
            </button>
          </div>
        </div>
      ))}

      {problems.waiting.length > 0 && (
        <div className="px-4 py-2 text-sm text-gray-800">
          <div className="font-semibold">{t('print_alerts.waiting', { count: problems.waiting.length })}</div>
          <ul className="mt-1 list-disc pl-5 text-xs text-gray-600">
            {problems.waiting.slice(0, 5).map((job) => (
              <li key={job.name}>{job.label}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default PrintAlerts;
