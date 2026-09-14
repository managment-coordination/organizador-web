"""Presentation-only renderer. Amounts are already calculated by ERP domains."""
import io
from xml.sax.saxutils import escape


def pdf_report(summary,rows):
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4,landscape
    from reportlab.lib.styles import getSampleStyleSheet,ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import SimpleDocTemplate,Paragraph,Spacer,Table,TableStyle
    out=io.BytesIO();styles=getSampleStyleSheet()
    styles.add(ParagraphStyle(name='BankCell',fontName='Helvetica',fontSize=8,leading=11,wordWrap='CJK'))
    def paragraph(value):return Paragraph(escape(str(value)),styles['BankCell'])
    story=[Paragraph('Conciliacion bancaria',styles['Title']),Spacer(1,4*mm)]
    info=Table([[paragraph(k),paragraph(v)] for k,v in summary],colWidths=[65*mm,190*mm])
    info.setStyle(TableStyle([('VALIGN',(0,0),(-1,-1),'TOP'),('BOTTOMPADDING',(0,0),(-1,-1),5)]))
    story.extend([info,Spacer(1,6*mm)])
    data=[[paragraph(c) for c in r] for r in rows]
    table=Table(data,colWidths=[25*mm,25*mm,87*mm,25*mm,42*mm,31*mm],repeatRows=1,hAlign='LEFT')
    table.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),colors.HexColor('#e7eeee')),
        ('VALIGN',(0,0),(-1,-1),'TOP'),('LINEBELOW',(0,0),(-1,-1),.4,colors.HexColor('#d9e1e1')),
        ('LEFTPADDING',(0,0),(-1,-1),5),('RIGHTPADDING',(0,0),(-1,-1),5),
        ('TOPPADDING',(0,0),(-1,-1),6),('BOTTOMPADDING',(0,0),(-1,-1),6)]))
    story.append(table)
    def footer(canvas,document):
        canvas.saveState();canvas.setFont('Helvetica',8)
        canvas.drawString(15*mm,10*mm,'ERP 5 - Fuente bancaria; no equivale a deuda ni a cierre contable.')
        canvas.drawRightString(282*mm,10*mm,str(document.page));canvas.restoreState()
    SimpleDocTemplate(out,pagesize=landscape(A4),leftMargin=15*mm,rightMargin=15*mm,
        topMargin=13*mm,bottomMargin=20*mm,title='Conciliacion bancaria',author='Organizador').build(story,onFirstPage=footer,onLaterPages=footer)
    return out.getvalue()
