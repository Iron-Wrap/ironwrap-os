from frappe.model.document import Document

from ironwrap_roofing.document_validation import validate_business_document
from ironwrap_roofing.document_validation import (
    validate_safety_acknowledgement_mutation,
    validate_safety_plan_frozen_content,
)


class SafetyPlan(Document):
    def validate(self) -> None:
        validate_safety_acknowledgement_mutation(self)
        validate_safety_plan_frozen_content(self)
        validate_business_document(self, "safety_plan")
