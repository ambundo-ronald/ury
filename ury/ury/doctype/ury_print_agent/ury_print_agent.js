frappe.ui.form.on("URY Print Agent", {
	refresh(frm) {
		if (frm.is_new()) return;

		frm.add_custom_button(__("Pair the Windows App"), () => {
			frm.call("new_pairing_code").then((r) => {
				const { code, minutes } = r.message;
				frappe.msgprint({
					title: __("Pairing Code"),
					indicator: "blue",
					message: __(
						"In the URY POS Windows app, open <b>Printing setup</b>, enter this site's address, agent name <b>{0}</b> and this code:<br><br><span style='font-size:2rem;letter-spacing:.3em'><b>{1}</b></span><br><br>It works once and expires in {2} minutes. Pairing again unpairs the PC paired before.",
						[frm.doc.agent_name, code, minutes]
					),
				});
			});
		});

		if (frm.doc.paired_on) {
			frm.add_custom_button(__("Unpair"), () => {
				frappe.confirm(__("This PC will stop printing until it is paired again. Continue?"), () =>
					frm.call("unpair").then(() => frm.reload_doc())
				);
			});
		}

		if (frm.doc.last_seen) {
			const seconds = moment().diff(moment(frm.doc.last_seen), "seconds");
			if (seconds < 90) {
				frm.dashboard.set_headline_alert(__("Online"), "green");
			} else {
				frm.dashboard.set_headline_alert(
					__("Offline since {0}", [frappe.datetime.prettyDate(frm.doc.last_seen)]),
					"red"
				);
			}
		}
	},
});
