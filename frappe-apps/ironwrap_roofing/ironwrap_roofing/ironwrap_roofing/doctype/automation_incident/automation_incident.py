from frappe.model.document import Document

from ironwrap_roofing.document_validation import validate_business_document


class AutomationIncident(Document):
    def validate(self):
        validate_business_document(self, "automation_incident")
