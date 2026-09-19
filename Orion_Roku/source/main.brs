sub Main()
    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.SetMessagePort(port)

    scene = screen.CreateScene("MainScene")
    registry = CreateObject("roRegistrySection", "Orion")
    serverUrl = registry.Read("serverUrl")
    scene.serverUrl = serverUrl

    screen.Show()
    while true
        message = wait(0, port)
        if type(message) = "roSGScreenEvent" and message.isScreenClosed() then return
    end while
end sub
