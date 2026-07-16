from frappe.model.document import Document

from ironwrap_roofing.document_validation import validate_business_document


class ContractAcceptance(Document):
    def validate(self) -> None:
        validate_business_document(self, "contract_acceptance")
