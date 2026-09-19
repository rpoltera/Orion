sub init()
    m.background = m.top.findNode("background")
    m.poster = m.top.findNode("poster")
    m.title = m.top.findNode("title")
    m.subtitle = m.top.findNode("subtitle")
end sub

sub showContent()
    item = m.top.itemContent
    if item = invalid then return
    poster = item.hdPosterUrl
    m.poster.visible = poster <> ""
    m.poster.uri = poster
    m.title.text = item.title
    m.subtitle.text = item.shortDescriptionLine1
    if item.accentColor <> invalid and item.accentColor <> "" then m.background.color = item.accentColor
end sub
