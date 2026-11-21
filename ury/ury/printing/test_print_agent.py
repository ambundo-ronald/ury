"""Print queue and print agent: routing, pairing, polling, reporting, POS alerts."""

import json
import sys
import types
from unittest.mock import patch

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import add_to_date, now_datetime

from ury.ury.printing import agent, api, queue

BRANCH = "URY Print Test Branch"
AGENT_PRINTER = "URY Test Agent Printer"
CUPS_PRINTER = "URY Test CUPS Printer"


def _printer(name):
	if not frappe.db.exists("Network Printer Settings", name):
		doc = frappe.new_doc("Network Printer Settings")
		doc.update({"server_ip": "127.0.0.1", "port": 631, "printer_name": name})
		doc.insert(set_name=name, ignore_permissions=True)


class TestPrintAgent(FrappeTestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		if not frappe.db.exists("Branch", BRANCH):
			branch = frappe.get_doc({"doctype": "Branch", "branch": BRANCH})
			branch.flags.ignore_mandatory = True
			branch.insert(ignore_permissions=True)
		_printer(AGENT_PRINTER)
		_printer(CUPS_PRINTER)
		frappe.db.delete("URY Print Job", {"printer": ["in", [AGENT_PRINTER, CUPS_PRINTER]]})
		frappe.db.delete("URY Print Agent Printer", {"printer": ["in", [AGENT_PRINTER, CUPS_PRINTER]]})
		if frappe.db.exists("URY Print Agent", "TEST-PC"):
			frappe.delete_doc("URY Print Agent", "TEST-PC", force=True, ignore_permissions=True)
		self.agent = frappe.get_doc(
			{
				"doctype": "URY Print Agent",
				"agent_name": "TEST-PC",
				"branch": BRANCH,
				"enabled": 1,
				"printers": [{"printer": AGENT_PRINTER, "windows_printer": "XP-80C Kitchen"}],
			}
		).insert(ignore_permissions=True)
		self.todo = frappe.get_doc({"doctype": "ToDo", "description": "Print me"}).insert(ignore_permissions=True)

	def tearDown(self):
		frappe.set_user("Administrator")
		frappe.db.rollback()

	def _pair(self):
		code = self.agent.new_pairing_code()["code"]
		return agent.pair("TEST-PC", code)["token"]

	def _as_agent(self, token):
		return patch.object(frappe, "get_request_header", return_value=f"TEST-PC:{token}")

	def _queue_todo(self):
		self.assertEqual(queue.send("ToDo", self.todo.name, AGENT_PRINTER, branch=BRANCH, label="KOT test"), "Queued")
		return frappe.get_all("URY Print Job", filters={"printer": AGENT_PRINTER}, pluck="name")[0]

	# Routing

	def test_printer_listed_on_an_enabled_agent_goes_to_it(self):
		self.assertEqual(queue.agent_for_printer(AGENT_PRINTER), "TEST-PC")
		self.assertIsNone(queue.agent_for_printer(CUPS_PRINTER))
		self.agent.db_set("enabled", 0)
		self.assertIsNone(queue.agent_for_printer(AGENT_PRINTER))

	def test_a_printer_cannot_belong_to_two_agents(self):
		other = frappe.get_doc(
			{
				"doctype": "URY Print Agent",
				"agent_name": "TEST-PC-2",
				"branch": BRANCH,
				"printers": [{"printer": AGENT_PRINTER, "windows_printer": "Other"}],
			}
		)
		self.assertRaises(frappe.ValidationError, other.insert, ignore_permissions=True)

	def test_agent_printer_is_queued_not_printed_by_server(self):
		with patch.object(queue, "print_with_cups") as cups:
			job = self._queue_todo()
		cups.assert_not_called()
		doc = frappe.get_doc("URY Print Job", job)
		self.assertEqual((doc.status, doc.agent, doc.branch), ("Queued", "TEST-PC", BRANCH))

	def test_cups_failure_is_kept_and_alerted(self):
		with patch.object(queue, "print_with_cups", return_value="printer offline"), patch.object(
			frappe, "publish_realtime"
		) as realtime:
			self.assertEqual(queue.send("ToDo", self.todo.name, CUPS_PRINTER, branch=BRANCH, label="KOT x"), "Failed")
		job = frappe.get_all("URY Print Job", filters={"printer": CUPS_PRINTER}, fields=["status", "error"])[0]
		self.assertEqual((job.status, job.error), ("Failed", "printer offline"))
		self.assertEqual(realtime.call_args.args[0], f"ury_print_alert_{BRANCH}")

	def test_cups_success_leaves_no_job(self):
		with patch.object(queue, "print_with_cups", return_value=None):
			self.assertEqual(queue.send("ToDo", self.todo.name, CUPS_PRINTER, branch=BRANCH), "Printed")
		self.assertFalse(frappe.get_all("URY Print Job", filters={"printer": CUPS_PRINTER}))

	def test_without_pycups_the_error_says_to_add_the_printer_to_an_agent(self):
		with patch.dict(sys.modules, {"cups": None}), patch(
			"frappe.utils.print_format.print_by_server"
		) as print_by_server:
			error = queue.print_with_cups("ToDo", self.todo.name, CUPS_PRINTER, None)
		print_by_server.assert_not_called()
		self.assertIn(CUPS_PRINTER, error)
		self.assertIn("URY Print Agent", error)
		self.assertNotIn("pycups", error)

	def test_with_pycups_the_print_server_is_used(self):
		with patch.dict(sys.modules, {"cups": types.ModuleType("cups")}), patch(
			"frappe.utils.print_format.print_by_server"
		) as print_by_server:
			self.assertIsNone(queue.print_with_cups("ToDo", self.todo.name, CUPS_PRINTER, None))
		print_by_server.assert_called_once_with("ToDo", self.todo.name, CUPS_PRINTER, None)

	def test_reprint_after_adding_the_printer_to_the_agent_queues_it(self):
		with patch.object(queue, "print_with_cups", return_value="no agent"), patch.object(frappe, "publish_realtime"):
			self.assertEqual(queue.send("ToDo", self.todo.name, CUPS_PRINTER, branch=BRANCH), "Failed")
		job = frappe.get_all("URY Print Job", filters={"printer": CUPS_PRINTER}, pluck="name")[0]
		self.agent.append("printers", {"printer": CUPS_PRINTER, "windows_printer": "XP-80C Kitchen"})
		self.agent.save(ignore_permissions=True)
		self.assertEqual(queue.retry(job), "Queued")
		self.assertEqual(frappe.db.get_value("URY Print Job", job, "agent"), "TEST-PC")

	# Pairing

	def test_pairing_code_works_once(self):
		code = self.agent.new_pairing_code()["code"]
		self.assertTrue(agent.pair("TEST-PC", code)["token"])
		self.assertRaises(frappe.AuthenticationError, agent.pair, "TEST-PC", code)

	def test_wrong_or_expired_code_is_refused(self):
		code = self.agent.new_pairing_code()["code"]
		wrong = "000000" if code != "000000" else "111111"
		self.assertRaises(frappe.AuthenticationError, agent.pair, "TEST-PC", wrong)
		frappe.db.set_value("URY Print Agent", "TEST-PC", "pairing_expires", add_to_date(now_datetime(), minutes=-1))
		self.assertRaises(frappe.AuthenticationError, agent.pair, "TEST-PC", code)

	def test_unknown_token_is_refused(self):
		self._pair()
		with self._as_agent("not-the-token"):
			self.assertRaises(frappe.AuthenticationError, agent.poll)

	def test_pairing_again_replaces_the_old_token(self):
		old = self._pair()
		self._pair()
		with self._as_agent(old):
			self.assertRaises(frappe.AuthenticationError, agent.poll)

	# Polling and reporting

	def test_poll_records_heartbeat_and_hands_out_html(self):
		token = self._pair()
		job = self._queue_todo()
		with self._as_agent(token):
			result = agent.poll(printers='["XP-80C Kitchen", "Microsoft Print to PDF"]', app_version="1.0.0")
		self.assertEqual([j["job"] for j in result["jobs"]], [job])
		sent = result["jobs"][0]
		self.assertEqual(sent["printer"], "XP-80C Kitchen")
		self.assertIn("Print me", sent["html"])
		row = frappe.db.get_value("URY Print Agent", "TEST-PC", ["last_seen", "detected_printers", "app_version"], as_dict=True)
		self.assertTrue(row.last_seen)
		self.assertIn("Microsoft Print to PDF", row.detected_printers)
		self.assertEqual(row.app_version, "1.0.0")
		self.assertEqual(frappe.db.get_value("URY Print Job", job, "status"), "Printing")

		# Not handed out twice while the agent is printing it.
		with self._as_agent(token):
			self.assertEqual(agent.poll()["jobs"], [])

	def test_unreported_job_is_offered_again_later(self):
		token = self._pair()
		job = self._queue_todo()
		with self._as_agent(token):
			agent.poll()
		frappe.db.set_value("URY Print Job", job, "claimed_at", add_to_date(now_datetime(), seconds=-agent.CLAIM_SECONDS - 5))
		with self._as_agent(token):
			self.assertEqual([j["job"] for j in agent.poll()["jobs"]], [job])

	def test_jobs_for_other_printers_are_not_handed_out(self):
		token = self._pair()
		with patch.object(queue, "print_with_cups", return_value="offline"):
			queue.send("ToDo", self.todo.name, CUPS_PRINTER, branch=BRANCH)
		with self._as_agent(token):
			self.assertEqual(agent.poll()["jobs"], [])

	def test_report_printed_and_failed(self):
		token = self._pair()
		first = self._queue_todo()
		with self._as_agent(token):
			agent.poll()
			self.assertEqual(agent.report(first, 1)["status"], "Printed")
		second = queue.send("ToDo", self.todo.name, AGENT_PRINTER, branch=BRANCH) and frappe.get_all(
			"URY Print Job", filters={"printer": AGENT_PRINTER, "status": "Queued"}, pluck="name"
		)[0]
		with self._as_agent(token), patch.object(frappe, "publish_realtime") as realtime:
			agent.poll()
			self.assertEqual(agent.report(second, 0, "Paper out")["status"], "Failed")
		self.assertEqual(frappe.db.get_value("URY Print Job", second, "error"), "Paper out")
		realtime.assert_called_once()

	def test_report_after_printed_does_not_change_it(self):
		token = self._pair()
		job = self._queue_todo()
		with self._as_agent(token):
			agent.poll()
			agent.report(job, 1)
			self.assertEqual(agent.report(job, 0, "late failure")["status"], "Printed")

	# POS side

	def test_pos_sees_failed_waiting_and_offline(self):
		with patch.object(queue, "print_with_cups", return_value="offline"):
			queue.send("ToDo", self.todo.name, CUPS_PRINTER, branch=BRANCH, label="KOT failed")
		waiting = self._queue_todo()
		frappe.db.set_value("URY Print Job", waiting, "creation", add_to_date(now_datetime(), seconds=-120))

		with patch.object(api.roles, "can_bill", return_value=True), patch.object(api, "_branch", return_value=BRANCH):
			problems = api.get_print_problems()
		self.assertEqual([j.label for j in problems["failed"]], ["KOT failed"])
		self.assertEqual([j.name for j in problems["waiting"]], [waiting])
		self.assertEqual([a.name for a in problems["offline_agents"]], ["TEST-PC"])

	def test_waiter_sees_no_problems_and_cannot_retry(self):
		job = self._queue_todo()
		with patch.object(api.roles, "can_bill", return_value=False), patch.object(api, "_branch", return_value=BRANCH):
			self.assertEqual(api.get_print_problems()["failed"], [])
			self.assertRaises(frappe.PermissionError, api.retry_print_job, job)

	def test_retry_requeues_for_the_agent(self):
		token = self._pair()
		job = self._queue_todo()
		with self._as_agent(token), patch.object(frappe, "publish_realtime"):
			agent.poll()
			agent.report(job, 0, "jam")
		with patch.object(api.roles, "can_bill", return_value=True), patch.object(api, "_branch", return_value=BRANCH):
			self.assertEqual(api.retry_print_job(job)["status"], "Queued")
		with self._as_agent(token):
			self.assertEqual([j["job"] for j in agent.poll()["jobs"]], [job])

	def test_cannot_touch_another_branchs_job(self):
		job = self._queue_todo()
		with patch.object(api.roles, "can_bill", return_value=True), patch.object(api, "_branch", return_value="Elsewhere"):
			self.assertRaises(frappe.PermissionError, api.dismiss_print_job, job)

	def test_kot_goes_through_the_queue_with_a_readable_label(self):
		kot = frappe.get_doc(
			{
				"doctype": "URY KOT",
				"name": "KOT-TEST-1",
				"production": "Kitchen",
				"restaurant_table": "T4",
				"branch": BRANCH,
				"type": "New Order",
				"table_takeaway": 0,
			}
		)
		rows = [frappe._dict(printer=AGENT_PRINTER, custom_kot_print_format="KOT Format", custom_kot_print=1, custom_block_takeaway_kot=0)]

		def fake_get_all(doctype, **kwargs):
			return rows if kwargs.get("filters", {}).get("parenttype") == "URY Production Unit" else []

		with patch("frappe.db.get_all", return_value=[]), patch("frappe.get_all", side_effect=fake_get_all), patch(
			"frappe.db.get_value", return_value=None
		), patch.object(queue, "send") as send:
			kot.multi_print_kot()
		send.assert_called_once_with(
			"URY KOT", "KOT-TEST-1", AGENT_PRINTER, "KOT Format", branch=BRANCH, label="KOT · Kitchen · T4"
		)

	def test_prepared_html_is_printed_as_is(self):
		token = self._pair()
		queue.send_html("ToDo", self.todo.name, AGENT_PRINTER, "<p>combined slip</p>", branch=BRANCH)
		with self._as_agent(token):
			jobs = agent.poll()["jobs"]
		self.assertIn("combined slip", jobs[0]["html"])


class TestKitchenOrderTicketFormat(FrappeTestCase):
	"""The kitchen ticket shipped with URY renders new, added, cancelled and takeaway tickets."""

	def setUp(self):
		path = frappe.get_app_path("ury", "ury", "print_format", "ury_kitchen_order_ticket", "ury_kitchen_order_ticket.json")
		with open(path) as f:
			self.format = json.load(f)

	def _render(self, **fields):
		kot = frappe.get_doc(
			{
				"doctype": "URY KOT",
				"name": "KOT-T-0001",
				"production": "Kitchen - Test Co",
				"restaurant_table": "T4",
				"table_takeaway": 0,
				"type": "New Order",
				"date": "2026-11-21",
				"time": "18:30:00",
				"order_no": "7",
				"kot_items": [{"item": "ITEM-1", "item_name": "Chicken Biryani", "quantity": "2", "comments": "no onion"}],
				**fields,
			}
		)
		return frappe.render_template(self.format["html"], {"doc": kot})

	def test_format_is_for_kot(self):
		self.assertEqual((self.format["name"], self.format["doc_type"]), ("URY Kitchen Order Ticket", "URY KOT"))

	def test_new_order(self):
		html = self._render()
		for text in ("Kitchen", "T4", "KOT-T-0001", "Chicken Biryani", "no onion", ">2<"):
			self.assertIn(text, html)
		self.assertNotIn("CANCEL", html)

	def test_added_items_and_takeaway(self):
		html = self._render(type="Order Modified", restaurant_table=None)
		self.assertIn("ADDED ITEMS", html)
		self.assertIn("Takeaway #7", html)

	def test_partial_cancel_shows_what_changed(self):
		html = self._render(
			type="Partially cancelled",
			kot_items=[{"item": "ITEM-1", "item_name": "Chicken Biryani", "quantity": "3", "cancelled_qty": "1"}],
		)
		self.assertIn("CANCEL", html)
		self.assertIn("was 3, now 2", html)
