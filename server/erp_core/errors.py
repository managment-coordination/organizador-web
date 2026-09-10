class ErpError(Exception):
    """Base error exposed by the internal ERP contract."""


class ContractError(ErpError, ValueError):
    pass


class ConflictError(ErpError):
    pass


class NotFoundError(ErpError):
    pass
