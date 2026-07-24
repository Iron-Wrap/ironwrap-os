from frappe.model.document import Document

from ironwrap_roofing.document_validation import validate_business_document


class AppointmentRequest(Document):
    def validate(self):
        validate_business_document(self, "appointment_request")
