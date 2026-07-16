from frappe.model.document import Document

from ironwrap_roofing.document_validation import validate_business_document


class VisualPropertyModel(Document):
    def validate(self):
        validate_business_document(self, "visual_property_model")
