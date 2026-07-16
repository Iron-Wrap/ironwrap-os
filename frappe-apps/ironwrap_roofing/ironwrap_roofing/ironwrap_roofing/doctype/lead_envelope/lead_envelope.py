from frappe.model.document import Document

from ironwrap_roofing.document_validation import validate_business_document
from ironwrap_roofing.document_validation import validate_lead_envelope_triage_mutation


class LeadEnvelope(Document):
    def validate(self):
        validate_lead_envelope_triage_mutation(self)
        validate_business_document(self, "lead_envelope")
