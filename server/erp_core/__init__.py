"""Deterministic foundations shared by future ERP domains."""

from .migrations import apply_all as apply_migrations

__all__ = ["apply_migrations"]
