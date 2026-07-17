from frappe.model.document import Document

from ironwrap_roofing.document_validation import validate_business_document
from ironwrap_roofing.document_validation import validate_proposal_publication_mutation


class ProposalEvidencePack(Document):
    def validate(self):
        validate_proposal_publication_mutation(self)
        validate_business_document(self, "proposal_evidence_pack")
