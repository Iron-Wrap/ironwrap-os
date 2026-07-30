from frappe.model.document import Document

from ironwrap_roofing.document_validation import validate_business_document
from ironwrap_roofing.document_validation import validate_work_package_runtime_mutation


class WorkPackage(Document):
    def validate(self) -> None:
        validate_work_package_runtime_mutation(self)
        validate_business_document(self, "work_package")
