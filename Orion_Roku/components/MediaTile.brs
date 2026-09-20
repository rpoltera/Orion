sub init()
    m.background = m.top.findNode("background")
    m.poster = m.top.findNode("poster")
    m.shade = m.top.findNode("shade")
    m.title = m.top.findNode("title")
    m.subtitle = m.top.findNode("subtitle")
    m.background.color = "24272B"
    m.shade.color = "080A0EE8"
    m.title.color = "F2F4F8"
    m.subtitle.color = "B7C0CC"
end sub

sub showContent()
    item = m.top.itemContent
    if item = invalid then return
    poster = item.hdPosterUrl
    m.poster.visible = poster <> ""
    m.poster.uri = poster
    m.background.color = "24272B"
    m.title.text = item.title
    m.subtitle.text = item.shortDescriptionLine1
end sub

function cleanColor(value as Dynamic, fallback as String) as String
    color = ""
    if value <> invalid then color = value.ToStr()
    if Left(color, 1) = "#" then color = Mid(color, 2)
    if Len(color) <> 6 then color = fallback
    if Left(color, 1) = "#" then color = Mid(color, 2)
    return UCase(color)
end function
