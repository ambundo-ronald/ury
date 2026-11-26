"""M-Pesa at the POS: picking received payments, STK prompts, and claiming them when settling.

The frappe_mpsa_payments app needs hrms and lending, so the test site does
not have it. These tests create stand-ins for its three doctypes with the
fields URY uses, and remove them afterwards.
"""

from unittest.mock import patch

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import add_to_date, now_datetime

from ury.ury.payments import mpesa

COMPANY = "URY Mpesa Test Co"
PAYBILL = "600111"
PROFILE = "URY Mpesa Test Profile"
MPESA = "URY Test M-Pesa"

STAND_INS = {
	"Mpesa Settings": (0, [("company", "Data"), ("business_shortcode", "Data"), ("till_number", "Data"), ("payment_gateway_name", "Data"), ("sandbox", "Check")]),
	"Mpesa C2B Payment Register": (
		1,
		[
			("full_name", "Data"), ("transid", "Data"), ("transamount", "Float"), ("businessshortcode", "Data"),
			("billrefnumber", "Data"), ("msisdn", "Data"), ("posting_date", "Date"), ("posting_time", "Time"),
			("company", "Data"), ("customer", "Data"), ("mode_of_payment", "Data"), ("submit_payment", "Check"),
			("pos_invoice", "Data"),
		],
	),
	"Mpesa Express Request": (
		1,
		[
			("settings", "Data"), ("phone_number", "Data"), ("amount", "Currency"), ("timestamp", "Datetime"),
			("reference_doctype", "Data"), ("reference_name", "Data"), ("checkout_request_id", "Data"),
			("response_description", "Data"), ("status", "Data"), ("transaction_id", "Data"), ("result_desc", "Data"),
		],
	),
}


def _make_stand_ins():
	for name, (submittable, fields) in STAND_INS.items():
		if frappe.db.exists("DocType", name):
			continue
		frappe.get_doc(
			{
				"doctype": "DocType",
				"name": name,
				"module": "URY",
				"custom": 1,
				"is_submittable": submittable,
				"autoname": "hash",
				"fields": [{"fieldname": f, "fieldtype": t, "label": f} for f, t in fields],
				"permissions": [{"role": "System Manager", "read": 1, "write": 1, "create": 1, "submit": submittable, "cancel": submittable}],
			}
		).insert(ignore_permissions=True)


def _drop_stand_ins():
	for name in STAND_INS:
		if frappe.db.get_value("DocType", name, "custom"):
			frappe.delete_doc("DocType", name, force=True, ignore_permissions=True)


class TestMpesaAtThePos(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		frappe.set_user("Administrator")
		_make_stand_ins()
		frappe.db.commit()

	@classmethod
	def tearDownClass(cls):
		frappe.db.rollback()
		_drop_stand_ins()
		frappe.db.commit()
		super().tearDownClass()

	def setUp(self):
		frappe.set_user("Administrator")
		frappe.get_doc({"doctype": "Mpesa Settings", "company": COMPANY, "business_shortcode": PAYBILL, "payment_gateway_name": "Test"}).insert()
		self.invoice = frappe._dict(name="ACC-PSINV-TEST-1", customer="Walk-In", company=COMPANY, pos_profile=PROFILE)
		self.patches = [
			patch.object(mpesa, "installed", return_value=True),
			patch.object(mpesa, "_phone_modes", return_value=[MPESA]),
			patch.object(mpesa.roles, "can_bill", return_value=True),
			patch.object(mpesa, "_profile", return_value=frappe._dict(company=COMPANY)),
		]
		for p in self.patches:
			p.start()

	def tearDown(self):
		for p in self.patches:
			p.stop()
		frappe.db.rollback()

	def _received(self, amount, code, shortcode=PAYBILL, name="Jane Wanjiku", phone="254712345678", age_hours=0):
		doc = frappe.get_doc(
			{
				"doctype": "Mpesa C2B Payment Register",
				"full_name": name,
				"transid": code,
				"transamount": amount,
				"businessshortcode": shortcode,
				"msisdn": phone,
			}
		).insert()
		if age_hours:
			doc.db_set("creation", add_to_date(now_datetime(), hours=-age_hours))
		return doc.name

	# Picking received payments

	def test_lists_recent_unused_payments_for_this_business_only(self):
		mine = self._received(500, "TKA1")
		self._received(300, "TKB2", shortcode="999999")
		self._received(200, "TKC3", age_hours=10)
		used = self._received(100, "TKD4")
		frappe.get_doc("Mpesa C2B Payment Register", used).submit()

		rows = mpesa.search_received(PROFILE)
		self.assertEqual([r["name"] for r in rows], [mine])
		self.assertEqual(rows[0]["phone"], "…678")
		self.assertNotIn("254712345678", str(rows))

	def test_search_finds_older_payments_by_code_name_or_phone(self):
		old = self._received(200, "TKC3XYZ", age_hours=30, name="Peter Otieno")
		self.assertEqual([r["name"] for r in mpesa.search_received(PROFILE, "c3x")], [old])
		self.assertEqual([r["name"] for r in mpesa.search_received(PROFILE, "Otieno")], [old])
		self.assertEqual(mpesa.search_received(PROFILE, "ab"), [])

	def test_claiming_marks_payments_used_and_sets_the_row(self):
		a = self._received(300, "TKA1")
		b = self._received(200, "TKB2")
		payments = [{"mode_of_payment": MPESA, "amount": 500, "mpesa_c2b": [a, b]}, {"mode_of_payment": "Cash", "amount": 100}]
		mpesa.claim_for_invoice(self.invoice, payments)

		self.assertEqual(payments[0]["reference_no"], "TKA1, TKB2")
		self.assertEqual(payments[1], {"mode_of_payment": "Cash", "amount": 100})
		for name in (a, b):
			doc = frappe.get_doc("Mpesa C2B Payment Register", name)
			self.assertEqual((doc.docstatus, doc.customer, doc.mode_of_payment, doc.submit_payment, doc.pos_invoice), (1, "Walk-In", MPESA, 0, self.invoice.name))

	def test_a_payment_cannot_pay_two_bills(self):
		a = self._received(500, "TKA1")
		mpesa.claim_for_invoice(self.invoice, [{"mode_of_payment": MPESA, "amount": 500, "mpesa_c2b": [a]}])
		other = frappe._dict(self.invoice, name="ACC-PSINV-TEST-2")
		with self.assertRaisesRegex(frappe.ValidationError, "already been used"):
			mpesa.claim_for_invoice(other, [{"mode_of_payment": MPESA, "amount": 500, "mpesa_c2b": [a]}])

	def test_refuses_another_business_payment(self):
		elsewhere = self._received(500, "TKX9", shortcode="999999")
		with self.assertRaisesRegex(frappe.ValidationError, "not paid to this business"):
			mpesa.claim_for_invoice(self.invoice, [{"mode_of_payment": MPESA, "amount": 500, "mpesa_c2b": [elsewhere]}])

	def test_refuses_an_amount_that_does_not_match(self):
		a = self._received(500, "TKA1")
		with self.assertRaisesRegex(frappe.ValidationError, "does not match"):
			mpesa.claim_for_invoice(self.invoice, [{"mode_of_payment": MPESA, "amount": 800, "mpesa_c2b": [a]}])

	def test_m_pesa_references_need_an_m_pesa_mode(self):
		a = self._received(500, "TKA1")
		with self.assertRaisesRegex(frappe.ValidationError, "not an M-Pesa mode"):
			mpesa.claim_for_invoice(self.invoice, [{"mode_of_payment": "Cash", "amount": 500, "mpesa_c2b": [a]}])

	# STK prompts

	def _express(self, status, amount=650, reference=None, code="TKS77"):
		return frappe.get_doc(
			{
				"doctype": "Mpesa Express Request",
				"reference_doctype": "POS Invoice",
				"reference_name": reference or self.invoice.name,
				"amount": amount,
				"status": status,
				"transaction_id": code if status == "Completed" else None,
				"result_desc": "Request cancelled by user" if status == "Failed" else None,
			}
		).insert().name

	def test_stk_status_is_waiting_paid_or_failed(self):
		self.assertEqual(mpesa.stk_status(PROFILE, self._express("In Progress"))["status"], "waiting")
		self.assertEqual(mpesa.stk_status(PROFILE, self._express("Completed")), {"status": "paid", "amount": 650, "receipt": "TKS77"})
		self.assertEqual(mpesa.stk_status(PROFILE, self._express("Failed")), {"status": "failed", "message": "Request cancelled by user"})

	def test_a_completed_prompt_settles_only_its_own_order(self):
		done = self._express("Completed")
		payments = [{"mode_of_payment": MPESA, "amount": 650, "mpesa_requests": [done]}]
		mpesa.claim_for_invoice(self.invoice, payments)
		self.assertEqual(payments[0]["reference_no"], "TKS77")

		other_order = self._express("Completed", reference="ACC-PSINV-OTHER")
		with self.assertRaisesRegex(frappe.ValidationError, "not for this order"):
			mpesa.claim_for_invoice(self.invoice, [{"mode_of_payment": MPESA, "amount": 650, "mpesa_requests": [other_order]}])
		waiting = self._express("In Progress")
		with self.assertRaisesRegex(frappe.ValidationError, "has not been paid"):
			mpesa.claim_for_invoice(self.invoice, [{"mode_of_payment": MPESA, "amount": 650, "mpesa_requests": [waiting]}])

	def test_phone_numbers_are_normalised(self):
		for raw in ("0712 345 678", "712345678", "+254712345678", "254712345678"):
			self.assertEqual(mpesa.normalise_phone(raw), "254712345678")
		self.assertEqual(mpesa.normalise_phone("0110123456"), "254110123456")
		for bad in ("0812345678", "12345", ""):
			self.assertRaises(frappe.ValidationError, mpesa.normalise_phone, bad)

	def test_no_app_means_no_m_pesa_and_no_change(self):
		with patch.object(mpesa, "installed", return_value=False):
			self.assertEqual(mpesa.get_config(PROFILE)["enabled"], False)
			self.assertEqual(mpesa.search_received(PROFILE), [])
			payments = [{"mode_of_payment": "Cash", "amount": 100}]
			self.assertEqual(mpesa.claim_for_invoice(self.invoice, payments), [])
			self.assertEqual(payments, [{"mode_of_payment": "Cash", "amount": 100}])

	def test_waiters_cannot_use_it(self):
		with patch.object(mpesa.roles, "can_bill", return_value=False):
			self.assertRaises(frappe.PermissionError, mpesa.search_received, PROFILE)
			self.assertRaises(frappe.PermissionError, mpesa.stk_status, PROFILE, "x")

	def test_sending_a_prompt_creates_an_express_request_for_the_order(self):
		order = frappe._dict(name=self.invoice.name, rounded_total=650, grand_total=650)
		settings = frappe._dict(name="Test")

		def accepted(doc, *args, **kwargs):
			doc.db_set("checkout_request_id", "ws_CO_1")

		with patch.object(mpesa, "_draft_invoice", return_value=order), patch.object(mpesa, "_stk_settings", return_value=settings), patch(
			"frappe.model.document.Document.submit", autospec=True, side_effect=accepted
		):
			sent = mpesa.request_stk(PROFILE, order.name, "0712 345 678", 650)
			with self.assertRaisesRegex(frappe.ValidationError, "more than the bill"):
				mpesa.request_stk(PROFILE, order.name, "0712345678", 900)
		request = frappe.get_doc("Mpesa Express Request", sent["request"])
		self.assertEqual(
			(request.phone_number, request.amount, request.reference_doctype, request.reference_name, request.settings),
			("254712345678", 650, "POS Invoice", order.name, "Test"),
		)
		self.assertEqual(sent["phone"], "…678")

	def test_a_prompt_safaricom_refused_is_reported(self):
		order = frappe._dict(name=self.invoice.name, rounded_total=650, grand_total=650)
		with patch.object(mpesa, "_draft_invoice", return_value=order), patch.object(
			mpesa, "_stk_settings", return_value=frappe._dict(name="Test")
		), patch("frappe.model.document.Document.submit", autospec=True):
			with self.assertRaisesRegex(frappe.ValidationError, "did not accept"):
				mpesa.request_stk(PROFILE, order.name, "0712345678", 650)
