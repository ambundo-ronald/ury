import { call } from '@ury/core';

export interface PrintJob {
  name: string;
  label: string;
  printer: string;
  error?: string | null;
  creation: string;
  status: string;
}

export interface PrintProblems {
  failed: PrintJob[];
  waiting: PrintJob[];
  offline_agents: { name: string; last_seen?: string | null }[];
}

const EMPTY: PrintProblems = { failed: [], waiting: [], offline_agents: [] };

/** Tickets and bills that did not print, or are waiting too long (cashier and above). */
export async function getPrintProblems(): Promise<PrintProblems> {
  const response = await call.get<{ message?: PrintProblems }>('ury.ury.printing.api.get_print_problems');
  return response.message ?? EMPTY;
}

export async function retryPrintJob(job: string): Promise<string> {
  const response = await call.post<{ message?: { status: string } }>('ury.ury.printing.api.retry_print_job', { job });
  return response.message?.status ?? '';
}

export async function dismissPrintJob(job: string): Promise<void> {
  await call.post('ury.ury.printing.api.dismiss_print_job', { job });
}
