from frappe.model.document import Document

from ironwrap_roofing.document_validation import validate_business_document


class CompletionPacket(Document):
    def before_insert(self):
        # Assign only on genuine insertion. Schema sync must not fabricate a
        # version on historical Approved packets that pre-date this contract.
        if self.get("packet_version") in (None, ""):
            self.packet_version = 1

    def validate(self):
        validate_business_document(self, "completion_packet")
