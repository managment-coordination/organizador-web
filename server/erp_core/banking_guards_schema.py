"""Bank reservation guards at the existing economic transaction boundary."""

STATEMENTS = (
    """CREATE TRIGGER erp4_void_reservation_guard BEFORE INSERT ON erp_rectificaciones
        WHEN NEW.kind='void' AND EXISTS (SELECT 1 FROM erp_remesa_reservas r
            WHERE r.id_comunidad=NEW.id_comunidad AND r.receipt_id=NEW.receipt_id AND r.state='activa')
        BEGIN SELECT RAISE(ABORT,'El recibo tiene una reserva bancaria activa'); END""",
    """CREATE TRIGGER erp4_receipt_change_guard AFTER UPDATE OF version ON erp_recibos
        WHEN NEW.version!=OLD.version AND EXISTS (SELECT 1 FROM erp_remesa_reservas v
            WHERE v.id_comunidad=NEW.id_comunidad AND v.receipt_id=NEW.id AND v.state='activa')
        BEGIN
            UPDATE erp_remesas SET needs_review=1,version=version+1 WHERE id_comunidad=NEW.id_comunidad AND id IN (
                SELECT rev.remittance_id FROM erp_remesa_revisiones rev
                JOIN erp_remesa_lineas line ON line.revision_id=rev.id
                JOIN erp_remesa_reservas r ON r.line_id=line.id
                WHERE r.id_comunidad=NEW.id_comunidad AND r.receipt_id=NEW.id AND r.state='activa');
        END""",
)
