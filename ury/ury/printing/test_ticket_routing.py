"""Kitchen and bar tickets: one PC prints them all, or each station prints its own orders."""

from unittest.mock import patch

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import add_to_date, now_datetime

from ury.ury.printing import queue
from ury.ury.station import session

PRINTER = "Test Routing Kitchen"
STATION = "TESTRTE1"
STATION_PC = "Test Station PC"
FALLBACK_PC = "Test Fallback PC"
OTHER_PC = "Test Other PC"


def set_settings(**values):
	for field, value in values.items():
		frappe.db.set_single_value("URY Station Settings", field, value)
	frappe.clear_document_cache("URY Station Settings", "URY Station Settings")


class TestTicketRouting(FrappeTestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		self.branch = frappe.db.get_value("Branch", {}, "name")
		if not self.branch:
			self.branch = frappe.get_doc({"doctype": "Branch", "branch": "Test Routing Branch"}).insert().name
		if not frappe.db.exists("Network Printer Settings", PRINTER):
			frappe.get_doc(
				{"doctype": "Network Printer Settings", "name": PRINTER, "printer_name": PRINTER, "server_ip": "localhost", "port": 631}
			).insert(ignore_permissions=True, set_name=PRINTER)
		set_settings(ticket_printing=queue.EACH_STATION, fallback_agent=None)
		# Oldest first: the fallback PC is created before the station PC.
		self.fallback = self.make_agent(FALLBACK_PC)
		self.station_pc = self.make_agent(STATION_PC)
		set_settings(fallback_agent=FALLBACK_PC)
		if not frappe.db.exists("URY Station", STATION):
			frappe.get_doc({"doctype": "URY Station", "code": STATION, "enabled": 1}).insert(ignore_permissions=True)
		frappe.db.set_value("URY Station", STATION, "print_agent", STATION_PC)
		self.seen(STATION_PC)

	def tearDown(self):
		frappe.db.rollback()
		frappe.clear_document_cache("URY Station Settings", "URY Station Settings")

	def make_agent(self, name, printer=PRINTER):
		if frappe.db.exists("URY Print Agent", name):
			frappe.delete_doc("URY Print Agent", name, force=True, ignore_permissions=True)
		return frappe.get_doc(
			{
				"doctype": "URY Print Agent",
				"agent_name": name,
				"branch": self.branch,
				"enabled": 1,
				"printers": [{"printer": printer, "windows_printer": "Kitchen"}],
			}
		).insert(ignore_permissions=True)

	def seen(self, agent, seconds_ago=0):
		frappe.db.set_value("URY Print Agent", agent, "last_seen", add_to_date(now_datetime(), seconds=-seconds_ago))

	def at(self, station):
		return patch.object(session, "current_station", return_value=station)

	def test_order_at_a_station_prints_on_that_station_pc(self):
		with self.at(STATION):
			self.assertEqual(queue.agent_for_printer(PRINTER), STATION_PC)

	def test_order_not_taken_at_a_station_goes_to_the_fallback_pc(self):
		with self.at(None):
			self.assertEqual(queue.agent_for_printer(PRINTER), FALLBACK_PC)

	def test_station_pc_switched_off_falls_back(self):
		self.seen(STATION_PC, seconds_ago=queue.STATION_AGENT_OFFLINE_SECONDS + 5)
		with self.at(STATION):
			self.assertEqual(queue.agent_for_printer(PRINTER), FALLBACK_PC)

	def test_station_pc_without_this_printer_falls_back(self):
		frappe.db.set_value("URY Station", STATION, "print_agent", None)
		with self.at(STATION):
			self.assertEqual(queue.agent_for_printer(PRINTER), FALLBACK_PC)

	def test_no_fallback_set_uses_the_oldest_agent(self):
		set_settings(fallback_agent=None)
		with self.at(None):
			self.assertEqual(queue.agent_for_printer(PRINTER), FALLBACK_PC)

	def test_one_pc_mode_ignores_the_station(self):
		frappe.db.set_single_value("URY Station Settings", "ticket_printing", queue.ONE_PC)
		frappe.clear_document_cache("URY Station Settings", "URY Station Settings")
		with self.at(STATION):
			self.assertEqual(queue.agent_for_printer(PRINTER), FALLBACK_PC)

	def test_queued_ticket_is_assigned_to_the_station_pc(self):
		with self.at(STATION):
			self.assertEqual(queue.send("URY Station", STATION, PRINTER, label="Kitchen T1"), "Queued")
		job = frappe.get_last_doc("URY Print Job", filters={"reference_name": STATION})
		self.assertEqual(job.agent, STATION_PC)

	def test_retry_from_the_cashier_goes_to_the_fallback_pc(self):
		with self.at(STATION):
			queue.send("URY Station", STATION, PRINTER)
		job = frappe.get_last_doc("URY Print Job", filters={"reference_name": STATION})
		job.db_set("status", "Failed")
		with self.at(None):
			self.assertEqual(queue.retry(job.name), "Queued")
		self.assertEqual(frappe.db.get_value("URY Print Job", job.name, "agent"), FALLBACK_PC)

	def test_one_pc_mode_refuses_a_printer_on_two_agents(self):
		set_settings(ticket_printing=queue.ONE_PC, fallback_agent=None)
		with self.assertRaises(frappe.ValidationError) as caught:
			self.make_agent(OTHER_PC)
		self.assertIn("Each station prints its own orders", str(caught.exception))

	def test_switching_back_to_one_pc_needs_one_agent_per_printer(self):
		settings = frappe.get_doc("URY Station Settings")
		settings.ticket_printing = queue.ONE_PC
		with self.assertRaises(frappe.ValidationError) as caught:
			settings.save()
		self.assertIn(PRINTER, str(caught.exception))


class TestPerStationOrder(FrappeTestCase):
	"""A real order through a PIN sign-in: its kitchen ticket goes to the station's PC.
	Needs a working restaurant whose production unit has a KOT printer (see
	test_order_attribution); skipped elsewhere. Run on a test site only."""

	def setUp(self):
		from ury.ury.station import test_utils as utils
		from ury.ury.station.test_order_attribution import find_restaurant

		self.utils = utils
		frappe.set_user("Administrator")
		utils.run_jobs_inline(self)
		utils.cleanup()
		self.restaurant = find_restaurant()
		if not self.restaurant:
			self.skipTest("Needs a POS Profile with an open POS session, a free table and a menu")
		units = frappe.get_all("URY Production Unit", filters={"branch": self.restaurant.branch}, pluck="name")
		if not units:
			self.skipTest("Needs a production unit")
		# Every production unit of the branch prints to a test printer.
		self.printer = PRINTER
		if not frappe.db.exists("Network Printer Settings", PRINTER):
			frappe.get_doc(
				{"doctype": "Network Printer Settings", "name": PRINTER, "printer_name": PRINTER, "server_ip": "localhost", "port": 631}
			).insert(ignore_permissions=True, set_name=PRINTER)
		self.added_rows = []
		for unit in units:
			doc = frappe.get_doc("URY Production Unit", unit)
			row = doc.append("printer_settings", {"printer": PRINTER, "custom_kot_print": 1})
			doc.save(ignore_permissions=True)
			self.added_rows.append(row.name)
		utils.make_station()
		self.addCleanup(utils.restore_settings, utils.stored_settings())
		frappe.db.set_single_value("URY Station Settings", "waiter_email_domain", utils.EMAIL_DOMAIN)
		set_settings(ticket_printing=queue.EACH_STATION, fallback_agent=None)
		for name in (FALLBACK_PC, STATION_PC):
			if frappe.db.exists("URY Print Agent", name):
				frappe.delete_doc("URY Print Agent", name, force=True, ignore_permissions=True)
			frappe.get_doc(
				{
					"doctype": "URY Print Agent",
					"agent_name": name,
					"branch": self.restaurant.branch,
					"enabled": 1,
					"printers": [{"printer": self.printer, "windows_printer": "Kitchen"}],
				}
			).insert(ignore_permissions=True)
		set_settings(fallback_agent=FALLBACK_PC)
		frappe.db.set_value("URY Print Agent", STATION_PC, "last_seen", now_datetime())
		frappe.db.set_value("URY Station", utils.TEST_STATION, "print_agent", STATION_PC)
		self.invoices = []
		self.addCleanup(self.remove_test_data)

	def remove_test_data(self):
		frappe.set_user("Administrator")
		for invoice in self.invoices:
			for kot in frappe.get_all("URY KOT", filters={"invoice": invoice}, pluck="name"):
				frappe.db.delete("URY Print Job", {"reference_name": kot})
				frappe.db.delete("URY KOT Items", {"parent": kot})
				frappe.db.delete("URY KOT", {"name": kot})
			frappe.delete_doc("POS Invoice", invoice, force=True, ignore_permissions=True)
		frappe.db.set_value("URY Table", self.restaurant.table, "occupied", 0, update_modified=False)
		for name in (STATION_PC, FALLBACK_PC):
			frappe.delete_doc("URY Print Agent", name, force=True, ignore_permissions=True)
		frappe.db.delete("URY Printer Settings", {"name": ["in", self.added_rows or ["-"]]})
		frappe.db.delete("URY Print Job", {"printer": PRINTER})
		frappe.delete_doc("Network Printer Settings", PRINTER, force=True, ignore_permissions=True)
		set_settings(ticket_printing=queue.ONE_PC, fallback_agent=None)
		self.utils.cleanup()
		frappe.db.commit()

	def test_kitchen_ticket_of_a_station_order_goes_to_the_station_pc(self):
		from ury.ury.station.test_utils import Browser
		from ury.ury.station.waiter import create_waiter

		pin = self.utils.new_pin()
		create_waiter("Routing Tester", pin, self.restaurant.branch, self.restaurant.profile)
		browser = Browser()
		self.assertTrue(browser.sign_in(pin)["ok"])
		item = self.restaurant.item
		response = browser._request(
			"post",
			"/api/method/ury.ury.doctype.ury_order.ury_order.sync_order",
			json=dict(
				items=[{"item": item.item, "item_name": item.item_name, "rate": item.rate, "qty": 1}],
				table=self.restaurant.table,
				room=self.restaurant.room,
				order_type="Dine In",
				pos_profile=self.restaurant.profile,
				no_of_pax=1,
				mode_of_payment="Cash",
				last_invoice=None,
				invoice=None,
				# Required by sync_order; the server uses the signed-in waiter instead.
				waiter=None,
				cashier=None,
				owner=None,
			),
		)
		self.assertEqual(response.status_code, 200, response.get_data(as_text=True)[-3000:])
		invoice = response.get_json()["message"]
		self.invoices.append(invoice["name"])
		kots = frappe.get_all("URY KOT", filters={"invoice": invoice["name"]}, pluck="name")
		jobs = frappe.get_all(
			"URY Print Job", filters={"reference_name": ["in", kots or ["-"]], "printer": self.printer}, fields=["agent"]
		)
		if not jobs:
			self.skipTest("The menu item is not in a production unit that prints to this printer")
		self.assertEqual({j.agent for j in jobs}, {STATION_PC})
