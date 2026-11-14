"""Read-only local asset copies; SVG thumbnails use macOS Quick Look."""
import hashlib
from pathlib import Path
import re
import shutil
import subprocess
import xml.etree.ElementTree as ET
from storage import atomic, resolve


def preview(request, home):
    root, file = resolve(request)
    if file.is_symlink() or not file.resolve().is_relative_to(root): raise ValueError('Open the asset target directly inside this folder')
    if file.suffix.lower() not in ['.png', '.jpg', '.jpeg', '.svg']: raise ValueError('Preview supports PNG, JPEG and SVG')
    if file.stat().st_size > 16 * 1024 * 1024: raise ValueError('Asset preview is limited to 16 MiB')
    data = file.read_bytes()
    cache = home / 'assets'; cache.mkdir(parents=True, mode=0o700, exist_ok=True)
    key = hashlib.sha256(data).hexdigest()
    copy = cache / (key + file.suffix.lower())
    atomic(copy, data)
    if file.suffix.lower() == '.svg':
        if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper() or b'XML-STYLESHEET' in data.upper(): raise ValueError('SVG entities and external styles are not supported')
        element = ET.fromstring(data)
        if element.tag not in ['svg', '{http://www.w3.org/2000/svg}svg']: raise ValueError('This is not an SVG document')
        for node in element.iter():
            tag = node.tag.rsplit('}', 1)[-1].lower()
            if tag in ['script', 'foreignobject', 'iframe', 'animate', 'set', 'animatetransform', 'animatemotion']:
                raise ValueError('Active SVG content cannot be previewed')
            for key_, value in node.attrib.items():
                key_ = key_.rsplit('}', 1)[-1].lower()
                if key_.startswith('on') or key_ == 'href' and not value.startswith('#') or re.search(r'url\s*\(|@import', value, re.I):
                    raise ValueError('External or active SVG content cannot be previewed')
            if tag == 'style' and re.search(r'url\s*\(|@import', node.text or '', re.I): raise ValueError('External SVG styles cannot be previewed')
        thumbnail = Path(str(copy) + '.png')
        if not thumbnail.exists():
            result = subprocess.run(['qlmanage', '-t', '-s', '1600', '-o', str(cache), str(copy)], capture_output=True, timeout=15)
            if result.returncode or not thumbnail.exists(): raise ValueError('macOS could not generate an SVG thumbnail')
            thumbnail.chmod(0o600)
        copy = thumbnail
    # Keep the cache bounded; never touch source assets.
    entries = sorted(cache.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in entries[60:]: old.unlink()
    result = subprocess.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', str(copy)], capture_output=True, text=True, timeout=10)
    width = re.search(r'pixelWidth: (\d+)', result.stdout)
    height = re.search(r'pixelHeight: (\d+)', result.stdout)
    if result.returncode or not width or not height: raise ValueError('macOS could not decode this image')
    return {'path': str(copy), 'source': request['path'], 'bytes': len(data), 'width': int(width[1]), 'height': int(height[1])}
