# M-Pesa at the cashier

The cashier can take M-Pesa in the URY POS payment screen in two ways:

- **Received payments:** the customer pays to the Paybill or Till from their
  phone. The payment appears in the list; the cashier ticks it.
- **Send prompt:** the cashier types the customer's number and the amount;
  the customer gets the M-Pesa PIN prompt on their phone (STK push), and the
  POS shows **Paid** with the M-Pesa code when they enter it.

URY does not talk to Safaricom itself. It uses the
[Frappe Mpsa Payments](https://github.com/navariltd/frappe-mpsa-payments) app
(Navari), which receives Safaricom's callbacks. Sites without that app see
no change. It works next to `cecypo_pos_mpesa`, which adds the same to
ERPNext's own Point of Sale: a payment used in one is gone from the other.

## Setting up

1. **Install** `frappe_mpsa_payments` on the site.
2. **Mpesa Settings** (Desk > Mpesa Settings > New), for the company:
   - Daraja consumer key and secret, the Paybill (business shortcode) and/or
     Till number, the online passkey (needed for prompts).
   - Untick **Sandbox** for live payments.
   - Leave **Auto Reconcile C2B** off. When it is on, every payment is
     processed as it arrives and never reaches the cashier's list.
   - Saving creates the payment gateway used for prompts.
3. **Register the C2B URLs** (Desk > Mpesa C2B Payment Register URL) so
   Safaricom sends Paybill/Till payments to the site.
4. **Mode of Payment** for M-Pesa: **Type: Phone**, with the company's
   M-Pesa account under Accounts.
5. **POS Profile** > Payment Methods: add that Mode of Payment.

Reload the POS. The payment screen shows an **M-Pesa** button on the
M-Pesa line.

## At the till

1. Open the order and click **Payment**, then **M-Pesa**.
2. **Received payments** lists unused payments from the last 6 hours, newest
   first; one matching the bill exactly shows its amount in green. Search by
   name, phone or M-Pesa code (3 characters or more) for older ones. Tick one
   or more: the M-Pesa amount is filled in and cash covers the rest.
3. Or **Send prompt**: check the number (taken from the customer when known)
   and the amount, then **Send M-Pesa prompt**. Wait for **Paid**. If nothing
   comes back within two minutes, **Check again**, or send a new prompt.
4. Click **Pay**. Only now are the M-Pesa payments used up. If paying fails,
   nothing is used and the cashier can try again.

The bill's payment row keeps the M-Pesa code(s) as its reference.

## Rules

- Only cashiers and managers can take M-Pesa payments.
- A payment can pay one bill only; two tills cannot use the same payment.
- Payments to another business's Paybill/Till are refused.
- The M-Pesa amount must match the payments chosen.
- A prompt's payment settles only the order it was sent for.

## For developers

| Part | Where |
|---|---|
| Server (config, list, prompt, status, claiming) | `ury/ury/payments/mpesa.py` |
| Claimed while settling | `make_invoice` in `ury/ury/doctype/ury_order/ury_order.py` |
| POS | `pos/src/components/MpesaPanel.tsx`, `pos/src/lib/mpesa-api.ts`, `PaymentDialog.tsx` |
| Tests | `ury.ury.payments.test_mpesa` |

Prompts use the app's **Mpesa Express Request** with the POS Invoice as
reference, not a Payment Request: for a draft POS Invoice the app's success
handler tries to create a Payment Entry, fails, and never marks the request
paid. Received payments are the app's draft **Mpesa C2B Payment Register**
records; claiming submits them with `submit_payment` off (no Payment Entry),
because the POS Invoice records the payment.
