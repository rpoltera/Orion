sub init()
    m.top.functionName = "run"
end sub

sub run()
    base = normalizeServer(m.top.serverUrl)
    if base = "" then
        m.top.error = "Press * and enter your Orion server address."
        return
    end if

    mode = m.top.mode
    if mode = "profiles" then
        loadProfiles(base)
    else if mode = "login" then
        login(base)
    else if mode = "episodes" then
        loadEpisodes(base)
    else if mode = "browse" then
        loadBrowse(base)
    else
        loadHome(base)
    end if
end sub

sub loadProfiles(base as String)
    data = fetchJson(base + "/api/roku/users")
    if data = invalid or data.users = invalid then
        m.top.error = "Could not load Orion profiles from " + base
        return
    end if
    m.top.payload = FormatJson({ mode: "profiles", users: data.users })
end sub

sub login(base as String)
    name = m.top.userName
    credential = m.top.credential
    if name = "" or credential = "" then
        m.top.error = "Enter the Orion profile PIN or password."
        return
    end if
    result = postJson(base + "/api/auth/login", { name: name, pin: credential })
    if result = invalid or result.token = invalid or result.token = "" then
        m.top.error = "Orion did not accept that PIN or password."
        return
    end if
    m.top.payload = FormatJson({ mode: "login", token: result.token, user: result.user })
end sub

sub loadHome(base as String)
    token = m.top.token
    catalog = fetchJson(withToken(base + "/api/roku/catalog", token))
    if catalog = invalid or catalog.rows = invalid then
        m.top.error = "Session expired. Choose your Orion profile again."
        return
    end if
    iptv = fetchPage(withToken(base + "/api/roku/iptv?page=0&limit=48", token))
    channels = fetchPage(withToken(base + "/api/roku/channels?page=0&limit=48", token))
    if iptv = invalid then iptv = { items: [], total: 0 }
    if channels = invalid then channels = { items: [], total: 0 }
    m.top.payload = FormatJson({
        mode: "home"
        user: catalog.user
        rows: catalog.rows
        iptv: pageItems(iptv)
        iptvTotal: pageTotal(iptv)
        channels: pageItems(channels)
        channelsTotal: pageTotal(channels)
    })
end sub

sub loadBrowse(base as String)
    section = m.top.section
    page = m.top.page
    limit = 80
    token = m.top.token
    result = invalid

    if section = "iptv" then
        result = fetchPage(withToken(base + "/api/roku/iptv?page=" + page.ToStr() + "&limit=" + limit.ToStr(), token))
    else if section = "channels" then
        result = fetchPage(withToken(base + "/api/roku/channels?page=" + page.ToStr() + "&limit=" + limit.ToStr(), token))
    else
        result = fetchPage(withToken(base + "/api/roku/browse?section=" + urlEscape(section) + "&page=" + page.ToStr() + "&limit=" + limit.ToStr(), token))
    end if

    if result = invalid then
        m.top.error = "Could not load " + sectionLabel(section) + "."
        return
    end if
    m.top.payload = FormatJson({
        mode: "browse"
        section: section
        page: page
        limit: limit
        items: pageItems(result)
        total: pageTotal(result)
    })
end sub

sub loadEpisodes(base as String)
    showName = m.top.showName
    if showName = "" then
        m.top.error = "This TV show has no name."
        return
    end if
    data = fetchJson(withToken(base + "/api/roku/episodes?showName=" + urlEscape(showName), m.top.token))
    if data = invalid then
        m.top.error = "Could not load episodes for " + showName
        return
    end if
    items = data.items
    if items = invalid then items = []
    m.top.payload = FormatJson({ mode: "episodes", title: showName, items: items, total: items.Count() })
end sub

function fetchPage(url as String) as Dynamic
    data = fetchJson(url)
    if data = invalid then return invalid
    if data.items = invalid then return { items: [], total: 0 }
    total = data.total
    if total = invalid then total = data.items.Count()
    return { items: data.items, total: total }
end function

function fetchJson(url as String) as Dynamic
    transfer = CreateObject("roUrlTransfer")
    transfer.SetUrl(url)
    transfer.AddHeader("Accept", "application/json")
    if m.top.token <> "" then transfer.AddHeader("Authorization", "Bearer " + m.top.token)
    body = transfer.GetToString()
    if transfer.GetResponseCode() <> 200 then return invalid
    return ParseJson(body)
end function

function postJson(url as String, payload as Object) as Dynamic
    transfer = CreateObject("roUrlTransfer")
    transfer.SetUrl(url)
    transfer.AddHeader("Accept", "application/json")
    transfer.AddHeader("Content-Type", "application/json")
    body = transfer.PostFromString(FormatJson(payload))
    if transfer.GetResponseCode() <> 200 then return invalid
    return ParseJson(body)
end function

function pageItems(page as Dynamic) as Object
    if page = invalid or page.items = invalid then return []
    return page.items
end function

function pageTotal(page as Dynamic) as Integer
    if page = invalid or page.total = invalid then return 0
    return page.total
end function

function withToken(url as String, token as String) as String
    if token = "" then return url
    separator = "?"
    if Instr(1, url, "?") > 0 then separator = "&"
    return url + separator + "token=" + token
end function

function normalizeServer(value as String) as String
    server = Trim(value)
    while Len(server) > 0 and Right(server, 1) = "/"
        server = Left(server, Len(server) - 1)
    end while
    return server
end function

function urlEscape(value as String) as String
    transfer = CreateObject("roUrlTransfer")
    return transfer.Escape(value)
end function

function sectionLabel(section as String) as String
    if section = "tvShows" then return "TV Shows"
    if section = "musicVideos" then return "Music Videos"
    if section = "iptv" then return "Live TV"
    if section = "channels" then return "Orion Channels"
    if section = "themes" then return "Themes"
    if section = "collections" then return "Collections"
    if Left(section, 7) = "genres:" then return "Categories"
    if Left(section, 6) = "genre:" then return "Category"
    if Left(section, 11) = "collection:" then return "Collection"
    if Left(section, 7) = "custom:" then return "Library"
    return section
end function
