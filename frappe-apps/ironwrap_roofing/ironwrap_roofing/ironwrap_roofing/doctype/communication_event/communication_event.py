from frappe.model.document import Document

from ironwrap_roofing.document_validation import validate_business_document


class CommunicationEvent(Document):
    def validate(self):
        validate_business_document(self, "communication_event")
