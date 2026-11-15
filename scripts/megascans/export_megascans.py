# Runs inside Unreal Editor 5.x and exports a Megascans pack (default: the European Beech trees)
# in a form SniperValley can use. Started by megascans.ps1 ("export" step):
#   UnrealEditor.exe <project> -ExecutePythonScript="<this file>"
# Environment:
#   SV_EXPORT_DIR  output folder (outside the git repository: Fab content must not be in it)
#   SV_PACK        word in the asset paths of the pack (default "beech")
#   SV_NEAR, SV_FAR  vertex budgets for the two exported LODs (default 60000 and 15000)
# Output:
#   meshes/<mesh>_lod<i>.glb   every mesh of the pack at two of its own LODs, geometry and
#                              material slots only (textures come separately, see below)
#   textures/<texture>.png     the textures the meshes' materials use, full size (megascans.ps1
#                              scales them to 2048 afterwards)
#   inventory.json             meshes (LOD vertex counts, size, Nanite), materials (parent,
#                              blend mode, texture/scalar/vector parameters), textures (size, sRGB,
#                              compression)
#   report.txt                 log; done.txt when finished
# Nothing is saved to the Unreal project (Nanite is switched off in memory only).
import json
import os
import re
import traceback

import unreal

OUT = os.environ.get('SV_EXPORT_DIR') or os.path.join(unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir()), 'SniperValleyExport')
PACK = (os.environ.get('SV_PACK') or 'beech').lower()
NEAR = int(os.environ.get('SV_NEAR') or 60000)
FAR = int(os.environ.get('SV_FAR') or 15000)

EAL = unreal.EditorAssetLibrary
LOG = []


def log(*parts):
    line = ' '.join(str(p) for p in parts)
    LOG.append(line)
    unreal.log('[SniperValley] ' + line)


def flush():
    with open(os.path.join(OUT, 'report.txt'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(LOG) + '\n')


def safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def setp(obj, name, value):
    try:
        obj.set_editor_property(name, value)
        return True
    except Exception as e:
        log('  (option', name, 'not set:', str(e).splitlines()[0] + ')')
        return False


def clean(name):
    return re.sub(r'[^A-Za-z0-9_.-]+', '_', name)


def class_of(data):
    v = safe(lambda: str(data.asset_class_path.asset_name))
    return v or safe(lambda: str(data.asset_class), '')


def object_path(data):
    return '%s.%s' % (data.package_name, data.asset_name)


# ---------------------------------------------------------------- find the pack and its dependencies

def find_assets():
    reg = unreal.AssetRegistryHelpers.get_asset_registry()
    safe(lambda: reg.search_all_assets(True))
    safe(lambda: reg.wait_for_completion())
    paths = EAL.list_assets('/Game', recursive=True, include_folder=False)
    pack = [p for p in paths if PACK in p.lower()]
    log('assets in /Game:', len(paths), '| with "%s" in the path:' % PACK, len(pack))
    opts = unreal.AssetRegistryDependencyOptions(
        include_soft_package_references=False, include_hard_package_references=True,
        include_searchable_names=False, include_soft_management_references=False,
        include_hard_management_references=False)
    found = {}   # object path -> class
    for p in pack:
        d = EAL.find_asset_data(p)
        found[p] = class_of(d)
    # follow the meshes' hard references (materials, their parents, textures)
    todo = [p.split('.')[0] for p, c in found.items() if c in ('StaticMesh', 'SkeletalMesh')]
    seen = set(todo)
    while todo:
        pkg = todo.pop()
        for dep in safe(lambda: reg.get_dependencies(pkg, opts), []) or []:
            dep = str(dep)
            if not dep.startswith('/Game/') or dep in seen:
                continue
            seen.add(dep)
            todo.append(dep)
            for d in safe(lambda: reg.get_assets_by_package_name(dep), []) or []:
                found.setdefault(object_path(d), class_of(d))
    return found


# ---------------------------------------------------------------- materials and textures

def material_info(mat, textures):
    info = {'path': safe(lambda: mat.get_path_name(), ''), 'class': mat.get_class().get_name()}
    base = safe(lambda: mat.get_base_material())
    if base:
        info['base'] = base.get_path_name()
        info['blend_mode'] = str(safe(lambda: base.get_editor_property('blend_mode'), ''))
        info['two_sided'] = safe(lambda: bool(base.get_editor_property('two_sided')))
        info['shading_model'] = str(safe(lambda: base.get_editor_property('shading_model'), ''))
    parent = safe(lambda: mat.get_editor_property('parent'))
    if parent:
        info['parent'] = parent.get_path_name()
    MEL = unreal.MaterialEditingLibrary
    tex, sca, vec = {}, {}, {}
    if isinstance(mat, unreal.MaterialInstance):
        for n in safe(lambda: MEL.get_texture_parameter_names(mat), []) or []:
            t = safe(lambda: MEL.get_material_instance_texture_parameter_value(mat, n))
            if t:
                tex[str(n)] = t.get_name()
                textures[t.get_path_name()] = t
        for n in safe(lambda: MEL.get_scalar_parameter_names(mat), []) or []:
            sca[str(n)] = safe(lambda: MEL.get_material_instance_scalar_parameter_value(mat, n))
        for n in safe(lambda: MEL.get_vector_parameter_names(mat), []) or []:
            v = safe(lambda: MEL.get_material_instance_vector_parameter_value(mat, n))
            if v is not None:
                vec[str(n)] = [round(v.r, 5), round(v.g, 5), round(v.b, 5), round(v.a, 5)]
    # textures used directly by the material graph (no parameter)
    for t in safe(lambda: MEL.get_used_textures(mat), []) or []:
        textures.setdefault(t.get_path_name(), t)
    info['textures'] = tex
    info['scalars'] = sca
    info['vectors'] = vec
    return info


def texture_info(t):
    return {
        'path': t.get_path_name(),
        'size': [safe(lambda: t.blueprint_get_size_x()), safe(lambda: t.blueprint_get_size_y())],
        'srgb': safe(lambda: bool(t.get_editor_property('srgb'))),
        'compression': str(safe(lambda: t.get_editor_property('compression_settings'), '')),
    }


def export_asset(obj, filename, options=None):
    task = unreal.AssetExportTask()
    task.object = obj
    task.filename = filename
    task.automated = True
    task.prompt = False
    task.replace_identical = True
    if options is not None:
        task.options = options
    return unreal.Exporter.run_asset_export_task(task)


def export_texture(t, folder):
    for ext in ('.png', '.tga', '.exr'):
        f = os.path.join(folder, clean(t.get_name()) + ext)
        if safe(lambda: export_asset(t, f), False) and os.path.exists(f):
            return os.path.basename(f)
    return None


# ---------------------------------------------------------------- meshes

def static_lods(sm):
    SMS = unreal.get_editor_subsystem(unreal.StaticMeshEditorSubsystem)
    n = SMS.get_lod_count(sm)
    return [SMS.get_number_verts(sm, i) for i in range(n)]


def skeletal_lods(sk):
    SKS = unreal.get_editor_subsystem(unreal.SkeletalMeshEditorSubsystem)
    n = SKS.get_lod_count(sk)
    return [SKS.get_num_verts(sk, i) for i in range(n)]


def disable_nanite(sm):
    ns = safe(lambda: sm.get_editor_property('nanite_settings'))
    if ns is None or not ns.enabled:
        return False
    ns.enabled = False
    SMS = unreal.get_editor_subsystem(unreal.StaticMeshEditorSubsystem)
    if safe(lambda: SMS.set_nanite_settings(sm, ns, True) or True, False):
        return True
    sm.set_editor_property('nanite_settings', ns)
    return True


def add_lods(sm):
    # a mesh with a single LOD: let Unreal reduce it (5% and 1.2% of the triangles)
    SMS = unreal.get_editor_subsystem(unreal.StaticMeshEditorSubsystem)
    for opt_cls, set_cls in (('StaticMeshReductionOptions', 'StaticMeshReductionSettings'),
                             ('EditorScriptingMeshReductionOptions', 'EditorScriptingMeshReductionSettings')):
        if not hasattr(unreal, opt_cls):
            continue
        S = getattr(unreal, set_cls)
        o = getattr(unreal, opt_cls)()
        o.set_editor_property('auto_compute_lod_screen_size', True)
        o.set_editor_property('reduction_settings', [S(1.0, 1.0), S(0.05, 0.3), S(0.012, 0.1)])
        if safe(lambda: SMS.set_lods(sm, o) or True, False):
            return True
    return False


def pick_lods(verts):
    def first_under(budget):
        for i, v in enumerate(verts):
            if v <= budget:
                return i
        return len(verts) - 1
    a, b = first_under(NEAR), first_under(FAR)
    return sorted({a, b})


def enum(cls, member):
    return safe(lambda: getattr(getattr(unreal, cls), member))


def gltf_options(lod):
    o = unreal.GLTFExportOptions()
    setp(o, 'default_level_of_detail', lod)
    setp(o, 'export_uniform_scale', 0.01)          # centimetres -> metres
    for prop, cls, member in (('bake_material_inputs', 'GLTFMaterialBakeMode', 'DISABLED'),
                              ('texture_image_format', 'GLTFTextureImageFormat', 'NONE'),
                              ('export_material_variants', 'GLTFMaterialVariantMode', 'NONE')):
        v = enum(cls, member)
        if v is not None:
            setp(o, prop, v)
    safe(lambda: o.set_editor_property('export_vertex_colors', True))
    safe(lambda: o.set_editor_property('export_mesh_quantization', False))
    safe(lambda: o.set_editor_property('export_lights', False))
    safe(lambda: o.set_editor_property('export_cameras', False))
    safe(lambda: o.set_editor_property('export_level_sequences', False))
    safe(lambda: o.set_editor_property('export_animation_sequences', False))
    return o


def export_glb(mesh, lod, filename):
    res = unreal.GLTFExporter.export_to_gltf(mesh, filename, gltf_options(lod), set())
    ok, msgs = (res if isinstance(res, tuple) else (res, None))
    if msgs is not None:
        for kind in ('errors', 'warnings'):
            for m in (safe(lambda: list(msgs.get_editor_property(kind)), []) or [])[:5]:
                log('    gltf', kind[:-1] + ':', m)
    return bool(ok) and os.path.exists(filename)


# ---------------------------------------------------------------- main

def main():
    os.makedirs(os.path.join(OUT, 'meshes'), exist_ok=True)
    os.makedirs(os.path.join(OUT, 'textures'), exist_ok=True)
    log('Unreal', unreal.SystemLibrary.get_engine_version())
    log('pack: "%s"  out: %s  LOD budgets: %d / %d vertices' % (PACK, OUT, NEAR, FAR))
    found = find_assets()
    by_class = {}
    for p, c in found.items():
        by_class.setdefault(c, []).append(p)
    for c in sorted(by_class):
        log('  %-32s %d' % (c, len(by_class[c])))
    flush()

    statics = sorted(p for p in by_class.get('StaticMesh', []) if PACK in p.lower())
    skeletals = sorted(p for p in by_class.get('SkeletalMesh', []) if PACK in p.lower())
    meshes = [(p, 'static') for p in statics] or [(p, 'skeletal') for p in skeletals]
    if not meshes:
        log('NO MESHES FOUND. Is the pack added to this project (Add to Project)?')
        return

    inv = {'engine': unreal.SystemLibrary.get_engine_version(), 'pack': PACK, 'meshes': [], 'materials': {}, 'textures': {}}
    textures = {}
    for idx, (path, kind) in enumerate(meshes):
        name = path.split('.')[-1]
        log('[%d/%d] %s (%s)' % (idx + 1, len(meshes), name, kind))
        try:
            mesh = EAL.load_asset(path)
            entry = {'name': name, 'path': path, 'kind': kind}
            if kind == 'static':
                b = mesh.get_bounds()
                ext = b.box_extent
                entry['size_m'] = [round(ext.x * 0.02, 2), round(ext.z * 0.02, 2), round(ext.y * 0.02, 2)]   # x, height, z
                entry['nanite'] = disable_nanite(mesh)
                verts = static_lods(mesh)
                if len(verts) == 1 and verts[0] > NEAR:
                    entry['generated_lods'] = add_lods(mesh)
                    verts = static_lods(mesh)
                slots = (safe(lambda: list(mesh.get_editor_property('static_materials')))
                         or safe(lambda: list(mesh.static_materials)) or [])
                mats = [(str(s.material_slot_name), s.material_interface) for s in slots]
            else:
                verts = skeletal_lods(mesh)
                slots = safe(lambda: list(mesh.get_editor_property('materials')), []) or []
                mats = [(str(s.material_slot_name), s.material_interface) for s in slots]
            entry['lod_vertices'] = verts
            log('    LOD vertices:', verts, '| Nanite was on' if entry.get('nanite') else '')
            entry['materials'] = []
            for slot, m in mats:
                if m is None:
                    continue
                mp = m.get_path_name()
                entry['materials'].append({'slot': slot, 'material': mp})
                if mp not in inv['materials']:
                    inv['materials'][mp] = material_info(m, textures)
            entry['files'] = {}
            for lod in pick_lods(verts):
                f = os.path.join(OUT, 'meshes', '%s_lod%d.glb' % (clean(name), lod))
                ok = safe(lambda: export_glb(mesh, lod, f), False)
                if ok:
                    entry['files']['lod%d' % lod] = os.path.relpath(f, OUT).replace('\\', '/')
                    log('    LOD%d -> %s (%.1f MB)' % (lod, os.path.basename(f), os.path.getsize(f) / 1e6))
                else:
                    log('    LOD%d export FAILED' % lod)
            inv['meshes'].append(entry)
        except Exception:
            log('    ERROR', traceback.format_exc())
        flush()

    log('textures:', len(textures))
    for tp, t in sorted(textures.items()):
        ti = texture_info(t)
        ti['file'] = export_texture(t, os.path.join(OUT, 'textures'))
        inv['textures'][t.get_name()] = ti
        log('  %-48s %s %s' % (t.get_name(), ti['size'], ti['file'] or 'EXPORT FAILED'))
    with open(os.path.join(OUT, 'inventory.json'), 'w', encoding='utf-8') as f:
        json.dump(inv, f, indent=1)
    n_files = sum(len(m['files']) for m in inv['meshes'])
    log('DONE: %d meshes, %d glb files, %d textures' % (len(inv['meshes']), n_files, len(textures)))


try:
    main()
except Exception:
    log('FATAL', traceback.format_exc())
finally:
    flush()
    with open(os.path.join(OUT, 'done.txt'), 'w') as f:
        f.write('done\n')
    safe(lambda: unreal.SystemLibrary.quit_editor())
