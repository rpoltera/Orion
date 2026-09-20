sub init()
    m.top.functionName = "loadTask"
end sub

sub loadTask()
    m.requestFailure = ""
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
    if data = invalid then
        m.top.error = requestError("Could not load Orion profiles from " + base)
        return
    end if
    if data.users = invalid then
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
    if result = invalid then
        m.top.error = requestError("Orion did not accept that PIN or password.")
        return
    end if
    if result.token = invalid then
        m.top.error = requestError("Orion did not accept that PIN or password.")
        return
    end if
    if result.token = "" then
        m.top.error = requestError("Orion did not accept that PIN or password.")
        return
    end if
    home = buildHome(base, result.token)
    if home = invalid then
        m.top.error = requestError("Orion signed in, but the Roku could not load your library.")
        return
    end if
    home.mode = "loginHome"
    home.token = result.token
    m.top.payload = FormatJson(home)
end sub

sub loadHome(base as String)
    home = buildHome(base, m.top.token)
    if home = invalid then return
    home.mode = "home"
    m.top.payload = FormatJson(home)
end sub

function buildHome(base as String, token as String) as Dynamic
    catalog = fetchJson(withToken(base + "/api/roku/catalog", token))
    if catalog = invalid then
        m.top.error = requestError("Session expired. Choose your Orion profile again.")
        return invalid
    end if
    if catalog.rows = invalid then
        m.top.error = "Session expired. Choose your Orion profile again."
        return invalid
    end if
    iptv = fetchPage(withToken(base + "/api/roku/iptv?page=0&limit=48", token))
    channels = fetchStreamForgeChannels(base, token, 0, 48)
    if iptv = invalid then iptv = { items: [], total: 0 }
    if channels = invalid then channels = { items: [], total: 0 }
    return {
        user: catalog.user
        rows: catalog.rows
        iptv: pageItems(iptv)
        iptvTotal: pageTotal(iptv)
        channels: pageItems(channels)
        channelsTotal: pageTotal(channels)
    }
end function

sub loadBrowse(base as String)
    section = m.top.section
    page = m.top.page
    limit = 80
    token = m.top.token
    result = invalid

    if section = "iptv" then
        result = fetchPage(withToken(base + "/api/roku/iptv?page=" + page.ToStr() + "&limit=" + limit.ToStr(), token))
    else if section = "channels" then
        result = fetchStreamForgeChannels(base, token, page, limit)
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

function fetchStreamForgeChannels(base as String, token as String, page as Integer, limit as Integer) as Dynamic
    data = fetchJson(withToken(base + "/api/sf/channels?light=1", token))
    if data = invalid then return invalid
    if type(data) <> "roArray" then return invalid
    allItems = []
    for each channel in data
        isActive = channel.active
        if isActive <> false then
            subtitle = channel.group
            if subtitle = invalid then subtitle = "Orion live channel"
            if subtitle = "" then subtitle = "Orion live channel"
            allItems.Push({
                id: channel.id
                title: channel.name
                subtitle: subtitle
                thumbnail: channel.logo
                kind: "channel"
                section: "channels"
            })
        end if
    end for
    output = []
    start = page * limit
    finish = start + limit - 1
    if finish >= allItems.Count() then finish = allItems.Count() - 1
    if finish >= start then
        for index = start to finish
            output.Push(allItems[index])
        end for
    end if
    return { items: output, total: allItems.Count() }
end function

function fetchJson(url as String) as Dynamic
    transfer = CreateObject("roUrlTransfer")
    port = CreateObject("roMessagePort")
    transfer.SetMessagePort(port)
    transfer.SetUrl(url)
    transfer.AddHeader("Accept", "application/json")
    if m.top.token <> "" then transfer.AddHeader("Authorization", "Bearer " + m.top.token)
    transfer.AsyncGetToString()
    event = wait(10000, port)
    if event = invalid then
        transfer.AsyncCancel()
        m.requestFailure = "The Roku could not reach Orion within 10 seconds."
        return invalid
    end if
    if type(event) <> "roUrlEvent" then
        transfer.AsyncCancel()
        m.requestFailure = "The Roku received an unexpected network response."
        return invalid
    end if
    code = event.GetResponseCode()
    if code <> 200 then
        m.requestFailure = "Orion returned HTTP " + code.ToStr() + "."
        return invalid
    end if
    body = event.GetString()
    if body = invalid then
        m.requestFailure = "Orion returned an empty response."
        return invalid
    end if
    if body = "" then
        m.requestFailure = "Orion returned an empty response."
        return invalid
    end if
    return ParseJson(body)
end function

function requestError(fallback as String) as String
    if m.requestFailure = invalid then return fallback
    if m.requestFailure <> "" then return m.requestFailure
    return fallback
end function

function postJson(url as String, payload as Object) as Dynamic
    transfer = CreateObject("roUrlTransfer")
    port = CreateObject("roMessagePort")
    transfer.SetMessagePort(port)
    transfer.SetUrl(url)
    transfer.AddHeader("Accept", "application/json")
    transfer.AddHeader("Content-Type", "application/json")
    if not transfer.AsyncPostFromString(FormatJson(payload)) then
        m.requestFailure = "The Roku could not start the Orion sign-in request."
        return invalid
    end if
    event = wait(10000, port)
    if event = invalid then
        transfer.AsyncCancel()
        m.requestFailure = "The Roku sign-in request timed out after 10 seconds."
        return invalid
    end if
    if type(event) <> "roUrlEvent" then
        transfer.AsyncCancel()
        m.requestFailure = "The Roku received an unexpected sign-in response."
        return invalid
    end if
    code = event.GetResponseCode()
    if code <> 200 then
        m.requestFailure = "Orion sign-in returned HTTP " + code.ToStr() + "."
        return invalid
    end if
    body = event.GetString()
    if body = invalid then
        m.requestFailure = "Orion sign-in returned an empty response."
        return invalid
    end if
    if body = "" then
        m.requestFailure = "Orion sign-in returned an empty response."
        return invalid
    end if
    return ParseJson(body)
end function

function pageItems(page as Dynamic) as Object
    if page = invalid then return []
    if page.items = invalid then return []
    return page.items
end function

function pageTotal(page as Dynamic) as Integer
    if page = invalid then return 0
    if page.total = invalid then return 0
    return page.total
end function

function withToken(url as String, token as String) as String
    if token = "" then return url
    separator = "?"
    if Instr(1, url, "?") > 0 then separator = "&"
    return url + separator + "token=" + token
end function

function normalizeServer(value as String) as String
    server = value.Trim()
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
