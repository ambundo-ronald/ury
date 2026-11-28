"""Bills printed by a waiter signed in at a station go to that station's printer."""

from unittest.mock import MagicMock, patch

import frappe
from frappe.tests.utils import FrappeTestCase

from ury.ury.api import ury_print
from ury.ury.station import session

STATION = "TESTPRN1"
PRINTER = "Test Station Bill Printer"


class TestStationBillPrinter(FrappeTestCase):
	def setUp(self):
		if not frappe.db.exists("Network Printer Settings", PRINTER):
			frappe.get_doc(
				{
					"doctype": "Network Printer Settings",
					"name": PRINTER,
					"printer_name": PRINTER,
					"server_ip": "localhost",
					"port": 631,
				}
			).insert(ignore_permissions=True, set_name=PRINTER)
		if not frappe.db.exists("URY Station", STATION):
			frappe.get_doc({"doctype": "URY Station", "code": STATION, "enabled": 1}).insert(ignore_permissions=True)
		frappe.db.set_value("URY Station", STATION, {"bill_printer": PRINTER, "enabled": 1})

	def tearDown(self):
		frappe.db.rollback()

	def at_station(self, station=STATION):
		return patch.object(session, "current_station", return_value=station)

	def test_station_printer_used_when_signed_in_there(self):
		with self.at_station():
			self.assertEqual(session.station_bill_printer(), PRINTER)

	def test_no_station_no_printer(self):
		with self.at_station(None):
			self.assertIsNone(session.station_bill_printer())

	def test_station_without_printer_or_disabled(self):
		frappe.db.set_value("URY Station", STATION, "bill_printer", None)
		with self.at_station():
			self.assertIsNone(session.station_bill_printer())
		frappe.db.set_value("URY Station", STATION, {"bill_printer": PRINTER, "enabled": 0})
		with self.at_station():
			self.assertIsNone(session.station_bill_printer())

	def _select(self, station_printer):
		sent = MagicMock(return_value="Success")
		with (
			patch.object(session, "station_bill_printer", return_value=station_printer),
			patch.object(ury_print, "network_printing", sent),
			patch("frappe.get_doc", return_value=MagicMock()),
			patch("frappe.has_permission", return_value=True),
			patch("frappe.db.get_value", return_value=None),
			patch("frappe.get_all", return_value=["Profile Bill Printer"]),
		):
			result = ury_print.select_network_printer("POS Profile X", "INV-1")
		return result, sent

	def test_select_network_printer_prefers_the_station_printer(self):
		result, sent = self._select(PRINTER)
		self.assertEqual(result, "Success")
		sent.assert_called_once_with("POS Invoice", "INV-1", PRINTER, None)

	def test_select_network_printer_without_station_uses_the_profile(self):
		result, sent = self._select(None)
		self.assertEqual(result, "Success")
		sent.assert_called_once_with("POS Invoice", "INV-1", "Profile Bill Printer", None)


class TestStationPrinterInThePos(FrappeTestCase):
	"""Through a real PIN sign-in: the POS is told to print bills at the station.
	Needs a working restaurant on the site (see test_order_attribution)."""

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
		utils.make_station()
		self.addCleanup(utils.restore_settings, utils.stored_settings())
		frappe.db.set_single_value("URY Station Settings", "waiter_email_domain", utils.EMAIL_DOMAIN)
		frappe.clear_document_cache("URY Station Settings", "URY Station Settings")
		if not frappe.db.exists("Network Printer Settings", PRINTER):
			frappe.get_doc(
				{"doctype": "Network Printer Settings", "name": PRINTER, "printer_name": PRINTER, "server_ip": "localhost", "port": 631}
			).insert(ignore_permissions=True, set_name=PRINTER)
			self.addCleanup(frappe.delete_doc, "Network Printer Settings", PRINTER, force=True, ignore_permissions=True)
		self.addCleanup(utils.cleanup)

	def pos_details(self, station_printer):
		from ury.ury.station.test_utils import Browser
		from ury.ury.station.waiter import create_waiter

		frappe.db.set_value("URY Station", self.utils.TEST_STATION, "bill_printer", station_printer)
		pin = self.utils.new_pin()
		create_waiter("Printer Tester", pin, self.restaurant.branch, self.restaurant.profile)
		browser = Browser()
		self.assertTrue(browser.sign_in(pin)["ok"])
		status, details = browser.call("ury.ury_pos.api.getPosProfile")
		self.assertEqual(status, 200, details)
		return details

	def test_waiter_at_a_station_with_a_printer_prints_there(self):
		details = self.pos_details(PRINTER)
		if details.get("qz_print"):
			self.skipTest("The POS Profile prints through QZ Tray")
		self.assertEqual(details["printer"], PRINTER)
		self.assertEqual(details["print_type"], "network")

	def test_station_without_a_printer_keeps_the_profile_printer(self):
		profile_printers = frappe.get_all(
			"URY Printer Settings",
			filters={"parent": self.restaurant.profile, "parenttype": "POS Profile", "bill": 1},
			pluck="printer",
			order_by="idx",
		)
		details = self.pos_details(None)
		self.assertEqual(details["printer"], ",".join(profile_printers) if profile_printers else None)
