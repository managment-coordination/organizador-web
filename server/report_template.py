"""Apply a community letterhead without Word/COM, subprocess conversion or style loss."""
import copy
import io
import posixpath
import zipfile
import xml.etree.ElementTree as ET
from xml.dom import minidom

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
P = 'http://schemas.openxmlformats.org/package/2006/relationships'
C = 'http://schemas.openxmlformats.org/package/2006/content-types'


def xml_bytes(root, originals):
    # mc:Ignorable contains prefix *values*, which ElementTree does not preserve.
    # Word rejects the package if these prefixes no longer have declarations.
    dom = minidom.parseString(ET.tostring(root,encoding='utf-8'))
    for original in originals:
        attrs = minidom.parseString(original).documentElement.attributes
        for index in range(attrs.length):
            attr = attrs.item(index)
            if attr.name.startswith('xmlns:') and not dom.documentElement.hasAttribute(attr.name):
                dom.documentElement.setAttribute(attr.name,attr.value)
    return dom.toxml(encoding='utf-8')


def apply_template(content, template_path):
    with zipfile.ZipFile(io.BytesIO(content)) as source, zipfile.ZipFile(template_path) as template:
        files = {name:source.read(name) for name in source.namelist()}
        types = ET.fromstring(files['[Content_Types].xml'])
        template_types = ET.fromstring(template.read('[Content_Types].xml'))
        overrides = {r.attrib.get('PartName'):r.attrib.get('ContentType') for r in template_types if r.tag.endswith('Override')}
        defaults = {r.attrib.get('Extension'):r.attrib.get('ContentType') for r in template_types if r.tag.endswith('Default')}
        known = {}

        def part(name):
            if name in known:
                return known[name]
            target = posixpath.join(posixpath.dirname(name), 'letterhead_' + posixpath.basename(name))
            known[name] = target
            files[target] = template.read(name)
            content_type = overrides.get('/'+name) or defaults.get(name.rsplit('.',1)[-1])
            if content_type:
                ET.SubElement(types, '{'+C+'}Override', {'PartName':'/'+target,'ContentType':content_type})
            rel_path = posixpath.join(posixpath.dirname(name),'_rels',posixpath.basename(name)+'.rels')
            if rel_path in template.namelist():
                rels = ET.fromstring(template.read(rel_path))
                for rel in rels:
                    if rel.get('TargetMode') == 'External':
                        continue
                    dependency = posixpath.normpath(posixpath.join(posixpath.dirname(name),rel.get('Target')))
                    rel.set('Target',posixpath.relpath(part(dependency),posixpath.dirname(target)))
                files[posixpath.join(posixpath.dirname(target),'_rels',posixpath.basename(target)+'.rels')] = ET.tostring(rels,encoding='utf-8',xml_declaration=True)
            return target

        doc = ET.fromstring(files['word/document.xml'])
        template_doc = ET.fromstring(template.read('word/document.xml'))
        template_section = template_doc.find('.//{'+W+'}sectPr')
        rels = ET.fromstring(files['word/_rels/document.xml.rels'])
        template_rels = {r.get('Id'):r for r in ET.fromstring(template.read('word/_rels/document.xml.rels'))}
        for section in doc.iter('{'+W+'}sectPr'):
            for child in list(section):
                if child.tag.rsplit('}',1)[-1] in {'headerReference','footerReference','pgSz','pgMar','pgBorders','titlePg'}:
                    section.remove(child)
            position = 0
            for original in template_section:
                if original.tag.rsplit('}',1)[-1] not in {'headerReference','footerReference','pgSz','pgMar','pgBorders','titlePg'}:
                    continue
                node = copy.deepcopy(original)
                if node.get('{'+R+'}id'):
                    relation = template_rels[node.get('{'+R+'}id')]
                    target = part(posixpath.normpath('word/'+relation.get('Target')))
                    rid = 'letterhead'+str(len(rels)+1)
                    ET.SubElement(rels,'{'+P+'}Relationship',{'Id':rid,'Type':relation.get('Type'),'Target':posixpath.relpath(target,'word')})
                    node.set('{'+R+'}id',rid)
                section.insert(position,node)
                position += 1
        # Header/footer styles can be absent in generated documents; retain their definitions.
        styles = ET.fromstring(files['word/styles.xml'])
        known_styles = {s.get('{'+W+'}styleId') for s in styles}
        known_names = {(s.find('{'+W+'}name').get('{'+W+'}val') or '').lower() for s in styles if s.find('{'+W+'}name') is not None}
        for style in ET.fromstring(template.read('word/styles.xml')):
            name = style.find('{'+W+'}name')
            duplicate_name = name is not None and (name.get('{'+W+'}val') or '').lower() in known_names
            if style.get('{'+W+'}styleId') and style.get('{'+W+'}styleId') not in known_styles and not duplicate_name:
                styles.append(copy.deepcopy(style))
        for name, root in [('word/document.xml',doc),('word/_rels/document.xml.rels',rels),('[Content_Types].xml',types),('word/styles.xml',styles)]:
            files[name] = xml_bytes(root,[source.read(name),template.read(name)])
        output = io.BytesIO()
        with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as archive:
            for name, data in files.items():
                archive.writestr(name,data)
        return output.getvalue()
