"""M-Pesa at the URY POS, on top of the frappe_mpsa_payments app (Navari).

URY does not talk to Safaricom itself. When that app is installed and has
Mpesa Settings for the company, the cashier can:

- pick payments the customer already sent to the Paybill or Till: draft
  "Mpesa C2B Payment Register" records the app creates from Safaricom's
  C2B callback; or
- send an STK push: an "Mpesa Express Request" for the POS Invoice, which
  the app sends to Safaricom and marks Completed (with the M-Pesa code) or
  Failed from Safaricom's callback. (A Payment Request is not used: for a
  draft POS Invoice the app's success handler tries to make a Payment Entry,
  fails, and never marks it paid.)

The chosen payments are only claimed when the bill is settled
(`claim_for_invoice`, called from `make_invoice` in the same transaction),
so a payment can never pay two bills and a failed settlement claims nothing.
Any Mode of Payment of type "Phone" in the POS Profile is treated as M-Pesa.
Sites without the app see no change.
"""

import frappe
from frappe import _
from frappe.utils import add_to_date, flt, now_datetime

from ury.ury import roles

APP = "frappe_mpsa_payments"
C2B = "Mpesa C2B Payment Register"
EXPRESS = "Mpesa Express Request"
SETTINGS = "Mpesa Settings"
# Unused payments shown before the cashier types anything.
RECENT_HOURS = 6
MAX_RESULTS = 20


def installed() -> bool:
	return APP in frappe.get_installed_apps()


def _phone_modes(pos_profile) -> list[str]:
	"""The POS Profile's modes of payment of type Phone, in the profile's order."""
	modes = frappe.get_all(
		"POS Payment Method", filters={"parent": pos_profile}, pluck="mode_of_payment", order_by="idx"
	)
	if not modes:
		return []
	phone = set(
		frappe.get_all("Mode of Payment", filters={"name": ["in", modes], "type": "Phone"}, pluck="name")
	)
	return [m for m in modes if m in phone]


def _settings(company) -> list[frappe._dict]:
	if not frappe.db.exists("DocType", SETTINGS):
		return []
	return frappe.get_all(
		SETTINGS,
		filters={"company": company},
		fields=["name", "business_shortcode", "till_number", "payment_gateway_name", "sandbox"],
	)


def _shortcodes(company) -> list[str]:
	"""Paybill and Till numbers payments for this company arrive on."""
	codes = []
	for s in _settings(company):
		for code in (s.business_shortcode, s.till_number):
			if code and str(code) not in codes:
				codes.append(str(code))
	return codes


def _profile(pos_profile):
	return frappe.get_cached_doc("POS Profile", pos_profile)


def _require_cashier(pos_profile):
	profile = _profile(pos_profile)
	if not roles.can_bill(pos_profile=profile):
		frappe.throw(_("Only a cashier or manager can take M-Pesa payments."), frappe.PermissionError)
	return profile


def _draft_invoice(invoice, pos_profile):
	doc = frappe.get_doc("POS Invoice", invoice)
	if doc.pos_profile != pos_profile:
		frappe.throw(_("This order belongs to another POS Profile."), frappe.PermissionError)
	if doc.docstatus != 0:
		frappe.throw(_("This order is already settled."))
	return doc


@frappe.whitelist()
def get_config(pos_profile):
	"""Whether this POS can take M-Pesa, and with which modes of payment."""
	profile = _require_cashier(pos_profile)
	off = {"enabled": False, "modes": [], "stk": False, "issues": []}
	if not installed():
		return off

	issues = []
	modes = _phone_modes(pos_profile)
	if not modes:
		issues.append(_("Add an M-Pesa Mode of Payment (type Phone) to the POS Profile."))
	settings = _settings(profile.company)
	if not settings:
		issues.append(_("Create Mpesa Settings for {0}.").format(profile.company))
	return {
		"enabled": bool(modes and settings),
		"modes": modes,
		"stk": bool(_stk_settings(profile.company)),
		"issues": issues,
	}


@frappe.whitelist()
def search_received(pos_profile, search=None):
	"""Unused M-Pesa payments received on this company's Paybill/Till.

	With no search text: those from the last few hours, newest first. With
	text (3 characters or more): matching name, phone, M-Pesa code or account
	reference, any age."""
	profile = _require_cashier(pos_profile)
	if not installed():
		return []
	codes = _shortcodes(profile.company)
	if not codes:
		return []

	filters = {"docstatus": 0, "businessshortcode": ["in", codes]}
	search = (search or "").strip()
	or_filters = None
	if search:
		if len(search) < 3:
			return []
		like = f"%{search}%"
		or_filters = {
			"full_name": ["like", like],
			"msisdn": ["like", like],
			"transid": ["like", like],
			"billrefnumber": ["like", like],
		}
	else:
		filters["creation"] = [">=", add_to_date(now_datetime(), hours=-RECENT_HOURS)]

	rows = frappe.get_all(
		C2B,
		filters=filters,
		or_filters=or_filters,
		fields=["name", "transid", "full_name", "msisdn", "transamount", "billrefnumber", "posting_date", "posting_time", "creation"],
		order_by="creation desc",
		limit=MAX_RESULTS,
	)
	return [
		{
			"name": r.name,
			"code": r.transid,
			"payer": r.full_name or "",
			"phone": _mask_phone(r.msisdn),
			"amount": flt(r.transamount),
			"reference": r.billrefnumber or "",
			"received": str(r.creation),
		}
		for r in rows
	]


def _mask_phone(msisdn) -> str:
	"""Safaricom may send a full number or a hash; show only the end of a number."""
	value = str(msisdn or "")
	return f"…{value[-3:]}" if value.isdigit() and len(value) > 6 else ""


def _stk_settings(company):
	"""Mpesa Settings that can send STK pushes: the app creates a Payment Gateway for each."""
	if not frappe.db.exists("DocType", "Payment Gateway"):
		return None
	for row in _settings(company):
		if frappe.db.exists("Payment Gateway", {"gateway_controller": row.name}):
			return row
	return None


def normalise_phone(phone) -> str:
	"""07XXXXXXXX, 7XXXXXXXX, +2547XXXXXXXX or 2547XXXXXXXX -> 2547XXXXXXXX."""
	digits = "".join(ch for ch in str(phone or "") if ch.isdigit())
	if digits.startswith("254"):
		digits = digits[3:]
	digits = digits.lstrip("0")
	if len(digits) != 9 or digits[0] not in "17":
		frappe.throw(_("Enter a Safaricom number like 0712 345 678."))
	return "254" + digits


@frappe.whitelist()
def request_stk(pos_profile, invoice, phone, amount):
	"""Send an M-Pesa prompt to the customer's phone for this order."""
	profile = _require_cashier(pos_profile)
	if not installed():
		frappe.throw(_("M-Pesa is not set up on this site."))
	doc = _draft_invoice(invoice, pos_profile)
	amount = flt(amount)
	if amount < 1:
		frappe.throw(_("Enter the amount to request."))
	if amount > flt(doc.rounded_total or doc.grand_total) + 0.5:
		frappe.throw(_("The amount is more than the bill."))
	phone = normalise_phone(phone)
	settings = _stk_settings(profile.company)
	if not settings:
		frappe.throw(_("M-Pesa prompts are not set up for {0}.").format(profile.company))

	request = frappe.get_doc(
		{
			"doctype": EXPRESS,
			"settings": settings.name,
			"phone_number": phone,
			# M-Pesa takes whole shillings.
			"amount": int(round(amount)),
			"timestamp": now_datetime(),
			"reference_doctype": "POS Invoice",
			"reference_name": doc.name,
		}
	)
	request.flags.ignore_permissions = True
	request.insert(ignore_permissions=True)
	# Submitting makes the app call Safaricom, which sends the prompt.
	request.submit()

	sent = frappe.db.get_value(EXPRESS, request.name, ["checkout_request_id", "response_description"], as_dict=True)
	if not sent.checkout_request_id:
		frappe.throw(
			_("M-Pesa did not accept the request. {0}").format(sent.response_description or _("Check the Mpesa Settings and the Error Log."))
		)
	return {"request": request.name, "phone": f"…{phone[-3:]}", "amount": int(round(amount))}


@frappe.whitelist()
def stk_status(pos_profile, request):
	"""Paid, waiting or failed, for the cashier's screen to poll."""
	_require_cashier(pos_profile)
	row = frappe.db.get_value(
		EXPRESS,
		request,
		["status", "amount", "transaction_id", "result_desc", "reference_doctype", "docstatus"],
		as_dict=True,
	)
	if not row or row.reference_doctype != "POS Invoice":
		frappe.throw(_("M-Pesa request not found."))
	if row.status == "Completed":
		return {"status": "paid", "amount": flt(row.amount), "receipt": row.transaction_id or ""}
	if row.status == "Failed" or row.docstatus == 2:
		return {"status": "failed", "message": row.result_desc or _("The customer did not complete the payment.")}
	return {"status": "waiting"}


def claim_for_invoice(invoice, payments) -> list[dict]:
	"""Claim the M-Pesa payments chosen for these payment rows.

	Called from make_invoice before the invoice is saved, in the same
	transaction: if settling fails, nothing is claimed. M-Pesa rows get their
	claimed amount and a reference_no (the M-Pesa codes); other rows are left
	unchanged. Returns the M-Pesa rows."""
	claimed_rows = []
	for row in payments:
		c2b_names = [n for n in (row.get("mpesa_c2b") or []) if n]
		request_names = [n for n in (row.get("mpesa_requests") or []) if n]
		if not c2b_names and not request_names:
			continue
		if not installed():
			frappe.throw(_("M-Pesa is not set up on this site."))
		mode = row["mode_of_payment"]
		if mode not in _phone_modes(invoice.pos_profile):
			frappe.throw(_("{0} is not an M-Pesa mode of payment in this POS Profile.").format(mode))

		codes = []
		total = 0.0
		for name in c2b_names:
			amount, code = _claim_c2b(name, invoice, mode)
			total += amount
			codes.append(code)
		for name in request_names:
			amount, code = _check_completed_request(name, invoice)
			total += amount
			codes.append(code)

		entered = flt(row.get("amount"))
		if abs(entered - total) > 0.5:
			frappe.throw(
				_("The M-Pesa amount ({0}) does not match the payments chosen ({1}).").format(entered, total)
			)
		# make_invoice appends these rows as they are now: the claimed amount and the M-Pesa codes.
		row["amount"] = total
		row["reference_no"] = ", ".join(codes)[:140]
		claimed_rows.append({"mode_of_payment": mode, "amount": total, "reference_no": row["reference_no"]})
	return claimed_rows


def _claim_c2b(name, invoice, mode):
	# Lock the row: two tills settling with the same payment at once must not both succeed.
	current = frappe.db.sql(f"select docstatus, businessshortcode from `tab{C2B}` where name=%s for update", name, as_dict=True)
	if not current:
		frappe.throw(_("M-Pesa payment {0} was not found.").format(name))
	if current[0].docstatus != 0:
		frappe.throw(_("M-Pesa payment {0} has already been used.").format(name))
	if str(current[0].businessshortcode or "") not in _shortcodes(invoice.company):
		frappe.throw(_("M-Pesa payment {0} was not paid to this business.").format(name))

	c2b = frappe.get_doc(C2B, name)
	c2b.customer = invoice.customer
	c2b.mode_of_payment = mode
	c2b.company = c2b.company or invoice.company
	# No Payment Entry: the POS Invoice records this payment.
	c2b.submit_payment = 0
	c2b.flags.ignore_permissions = True
	c2b.save(ignore_permissions=True)
	c2b.submit()
	if frappe.get_meta(C2B).has_field("pos_invoice"):
		c2b.db_set("pos_invoice", invoice.name, update_modified=False)
	return flt(c2b.transamount), c2b.transid or name


def _check_completed_request(name, invoice):
	request = frappe.db.get_value(
		EXPRESS,
		name,
		["status", "amount", "transaction_id", "reference_doctype", "reference_name"],
		as_dict=True,
	)
	if not request or request.reference_doctype != "POS Invoice" or request.reference_name != invoice.name:
		frappe.throw(_("M-Pesa request {0} is not for this order.").format(name))
	if request.status != "Completed":
		frappe.throw(_("M-Pesa request {0} has not been paid.").format(name))
	return flt(request.amount), request.transaction_id or name
