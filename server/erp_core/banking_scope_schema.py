"""Referential mandate scope; encrypted evidence is not the relationship registry."""

STATEMENTS = (
    """CREATE TABLE erp_mandato_propiedades (
        id_comunidad INTEGER NOT NULL,
        mandate_version_id INTEGER NOT NULL,
        property_id INTEGER NOT NULL,
        PRIMARY KEY(id_comunidad,mandate_version_id,property_id),
        FOREIGN KEY(id_comunidad,mandate_version_id) REFERENCES erp_mandato_versiones(id_comunidad,id),
        FOREIGN KEY(id_comunidad,property_id) REFERENCES cf_propiedades(id_comunidad,id_propiedad)
    )""",
    """CREATE TRIGGER erp_mandato_propiedades_no_update BEFORE UPDATE ON erp_mandato_propiedades
        BEGIN SELECT RAISE(ABORT,'El alcance historico del mandato es inmutable'); END""",
    """CREATE TRIGGER erp_mandato_propiedades_no_delete BEFORE DELETE ON erp_mandato_propiedades
        BEGIN SELECT RAISE(ABORT,'El alcance historico del mandato es inmutable'); END""",
)
