# Migración area-malaga-beach → checkingsmart-564a0

Scripts para mover los datos de un tenant desde el proyecto Firebase **legacy**
(`area-malaga-beach`) al proyecto **prod** (`checkingsmart-564a0`).

## Scripts

| Archivo | Función |
|---------|---------|
| `migrate-export.js` | Exporta `tenants/{tenantId}/*` a JSON local en `./backup/` |
| `migrate-import.js` | Sube un JSON al proyecto prod |
| `migrate-verify.js` | Compara conteos y hace muestreo aleatorio origen vs destino |

## 1. Descargar Service Accounts

Necesitas DOS archivos JSON con credenciales de servicio:

### service-account-legacy.json (origen)
1. Firebase Console → proyecto **area-malaga-beach**
2. ⚙️ Configuración del proyecto → pestaña **Cuentas de servicio**
3. Botón **Generar nueva clave privada** → descargar JSON
4. Renombrar a `service-account-legacy.json` y colocar en esta carpeta

### service-account-prod.json (destino)
1. Firebase Console → proyecto **checkingsmart-564a0**
2. ⚙️ Configuración del proyecto → pestaña **Cuentas de servicio**
3. Botón **Generar nueva clave privada** → descargar JSON
4. Renombrar a `service-account-prod.json` y colocar en esta carpeta

> ⚠️  Estos archivos NO deben subirse a git. Ya están en `.gitignore` del proyecto.

## 2. Orden de ejecución

Desde `_platform/functions/migration/`:

```bash
# A) EXPORTAR desde legacy
node migrate-export.js camperpark-roquetas
# → genera ./backup/camperpark-roquetas-<timestamp>.json

# B) IMPORTAR a prod
node migrate-import.js backup/camperpark-roquetas-<timestamp>.json

# C) VERIFICAR (conteos + muestreo aleatorio de 20 docs)
node migrate-verify.js camperpark-roquetas 20
```

Repetir A/B/C para cada tenant:

```bash
node migrate-export.js area-malaga-beach
node migrate-import.js backup/area-malaga-beach-<timestamp>.json
node migrate-verify.js area-malaga-beach 20
```

## 3. Qué se preserva

- Todas las subcolecciones bajo `tenants/{tenantId}/` (recursivo, sin límite de profundidad)
- El documento raíz `tenants/{tenantId}` si existe
- Tipos especiales de Firestore: `Timestamp`, `GeoPoint`, `DocumentReference`, `Bytes`
- IDs originales de cada documento

## 4. Qué NO se preserva

- **Firebase Auth users**: se migran aparte con otro script (pendiente)
- **Cloud Storage files**: se migran aparte si hay (ninguno tiene ahora)
- **Índices compuestos de Firestore**: se despliegan con `firebase deploy --only firestore:indexes`
- **Reglas de seguridad**: se despliegan con `firebase deploy --only firestore:rules`

## 5. Límites

- Firestore batch: 500 operaciones (el writer flush en 400 por seguridad)
- No hay paginación; para tenants > 1 millón de docs habría que reescribir con cursores
- Para los tenants actuales (~6.000 clientes Roquetas + 0 AMB) el JSON cabe cómodamente en RAM

## 6. Rollback

- El JSON exportado se queda en `./backup/` → sirve como snapshot
- Si algo sale mal: NO borrar legacy hasta que `migrate-verify.js` dé ✅
- Tras verificación OK: eliminar proyecto `area-malaga-beach` desde Firebase Console
