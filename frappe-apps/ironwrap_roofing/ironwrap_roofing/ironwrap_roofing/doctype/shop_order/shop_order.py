from frappe.model.document import Document

from ironwrap_roofing.document_validation import validate_business_document
from ironwrap_roofing.document_validation import validate_shop_order_runtime_mutation


class ShopOrder(Document):
    def validate(self):
        validate_shop_order_runtime_mutation(self)
        validate_business_document(self, "shop_order")
