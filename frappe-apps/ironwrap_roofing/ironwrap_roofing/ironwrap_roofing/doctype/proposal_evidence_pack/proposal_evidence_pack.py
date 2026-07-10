from frappe.model.document import Document

from ironwrap_roofing.document_validation import validate_business_document


class ProposalEvidencePack(Document):
    def validate(self):
        validate_business_document(self, "proposal_evidence_pack")
