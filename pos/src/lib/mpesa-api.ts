import { call } from '@ury/core';

// M-Pesa at the cashier, through the frappe_mpsa_payments app (ury/ury/payments/mpesa.py).

export interface MpesaConfig {
  enabled: boolean;
  /** Modes of payment of type Phone in the POS Profile. */
  modes: string[];
  /** Whether STK prompts can be sent. */
  stk: boolean;
  issues: string[];
}

export interface ReceivedPayment {
  name: string;
  code: string;
  payer: string;
  phone: string;
  amount: number;
  reference: string;
  received: string;
}

export type StkStatus =
  | { status: 'waiting' }
  | { status: 'paid'; amount: number; receipt: string }
  | { status: 'failed'; message: string };

const M = 'ury.ury.payments.mpesa';
const OFF: MpesaConfig = { enabled: false, modes: [], stk: false, issues: [] };

export async function getMpesaConfig(posProfile: string): Promise<MpesaConfig> {
  try {
    const response = await call.get<{ message?: MpesaConfig }>(`${M}.get_config`, { pos_profile: posProfile });
    return response.message ?? OFF;
  } catch {
    // Older servers without the endpoint, or a waiter: no M-Pesa options.
    return OFF;
  }
}

export async function searchReceived(posProfile: string, search = ''): Promise<ReceivedPayment[]> {
  const response = await call.get<{ message?: ReceivedPayment[] }>(`${M}.search_received`, {
    pos_profile: posProfile,
    search,
  });
  return response.message ?? [];
}

export async function requestStk(posProfile: string, invoice: string, phone: string, amount: number) {
  const response = await call.post<{ message: { request: string; phone: string; amount: number } }>(`${M}.request_stk`, {
    pos_profile: posProfile,
    invoice,
    phone,
    amount,
  });
  return response.message;
}

export async function getStkStatus(posProfile: string, request: string): Promise<StkStatus> {
  const response = await call.get<{ message: StkStatus }>(`${M}.stk_status`, { pos_profile: posProfile, request });
  return response.message;
}
