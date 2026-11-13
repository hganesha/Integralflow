"""Package source/config/docs only. Never include runtime databases or private secrets."""
from pathlib import Path
import json,hashlib,zipfile
P=Path(__file__).resolve().parents[1]
skip_parts={'.local','.venv','__pycache__','.pytest_cache','.git','node_modules'}
skip_names={'.env','.provider-secrets.env','bundle-manifest.json','browser-install.txt','browser-system-deps.txt'}
files=[f for f in P.rglob('*') if f.is_file() and not skip_parts.intersection(f.relative_to(P).parts) and f.name not in skip_names and f.suffix not in ['.db','.sqlite','.pyc','.zip']]
manifest={'version':'2.0.0','snapshot_date':'2026-10-15','live_vendor_connections_validated':0,'automated_tests_passed':813,'documented_vendor_clients':42,'concrete_native_operations':732,'unimplemented_catalog_records':334,'catalog_bindings':824,'simulated_end_to_end':822,'quarantined_bindings':2,'files':[{'path':str(f.relative_to(P)),'bytes':f.stat().st_size,'sha256':hashlib.sha256(f.read_bytes()).hexdigest()} for f in sorted(files)]}
(P/'bundle-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
archive=P.parent/'KYC_Documented_Vendor_Connections_v2.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
 for f in files+[P/'bundle-manifest.json']:z.write(f,Path('api-wiring')/f.relative_to(P))
with zipfile.ZipFile(archive) as z:
 assert z.testzip() is None
 assert not any('/.local/'in n or n.endswith('/.env') or n.endswith('/.provider-secrets.env') for n in z.namelist())
print('Packaged',len(files)+1,'files;',archive.stat().st_size,'bytes;',archive)
