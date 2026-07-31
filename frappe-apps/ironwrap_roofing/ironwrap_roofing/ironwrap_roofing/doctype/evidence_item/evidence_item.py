from frappe.model.document import Document

from ironwrap_roofing.document_validation import validate_business_document
from ironwrap_roofing.document_validation import validate_facet_design_projection_evidence_mutation
from ironwrap_roofing.document_validation import validate_evidence_verification_mutation


class EvidenceItem(Document):
    def validate(self):
        validate_facet_design_projection_evidence_mutation(self)
        validate_evidence_verification_mutation(self)
        validate_business_document(self, "evidence_item")
