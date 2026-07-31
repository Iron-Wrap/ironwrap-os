from frappe.model.document import Document

from ironwrap_roofing.document_validation import validate_business_document
from ironwrap_roofing.document_validation import validate_contract_acceptance_mutation


class ContractAcceptance(Document):
    def validate(self) -> None:
        validate_contract_acceptance_mutation(self)
        validate_business_document(self, "contract_acceptance")
