sub init()
    m.background = m.top.findNode("background")
    m.poster = m.top.findNode("poster")
    m.shade = m.top.findNode("shade")
    m.title = m.top.findNode("title")
    m.subtitle = m.top.findNode("subtitle")
    registry = CreateObject("roRegistrySection", "Orion")
    m.background.color = cleanColor(registry.Read("themeCard"), "171D33")
    m.shade.color = cleanColor(registry.Read("themeCard"), "171D33")
    m.title.color = cleanColor(registry.Read("themeText"), "F9FAFB")
    m.subtitle.color = cleanColor(registry.Read("themeMuted"), "B8C0D0")
end sub

sub showContent()
    item = m.top.itemContent
    if item = invalid then return
    poster = item.hdPosterUrl
    m.poster.visible = poster <> ""
    m.poster.uri = poster
    m.title.text = item.title
    m.subtitle.text = item.shortDescriptionLine1
    if item.accentColor <> invalid and item.accentColor <> "" and poster = "" then m.background.color = cleanColor(item.accentColor, "171D33")
end sub

function cleanColor(value as Dynamic, fallback as String) as String
    color = ""
    if value <> invalid then color = value.ToStr()
    if Left(color, 1) = "#" then color = Mid(color, 2)
    if Len(color) <> 6 then color = fallback
    if Left(color, 1) = "#" then color = Mid(color, 2)
    return UCase(color)
end function
